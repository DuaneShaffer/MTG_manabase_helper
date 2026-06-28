// Optimal manabase via Integer Linear Programming.
//
// An alternative to the greedy recommender in recommend.js: instead of picking
// locally-best lands, this asks a solver for the *provably optimal* land set for
// a chosen objective, subject to meeting every color's source requirement.
//
// The solver (vendored jsLPSolver) is loaded lazily on first use so the app stays
// light for everyone who never opens the optimizer. The model builder is pure and
// exported so it can be unit-tested without a browser.

import { COLORS } from "./colors.js";

const NONBASIC_MAX = 4; // singleton/playset rule

const BASIC_TYPES = /\b(Plains|Island|Swamp|Mountain|Forest)\b/;
const POPULARITY_WEIGHT = 50; // how strongly metagame play-rate breaks ties between equivalent lands

// Empirical land popularity (inclusion rate in winning decks), injected at boot.
// name -> { score: 0..1 }. Empty until setLandPopularity() is called, so the
// structural score below still works on its own (and in tests).
let _popularity = {};
export function setLandPopularity(map) { _popularity = map || {}; }

// A land-quality score used to order interchangeable lands (same colors / tapped /
// basic signature) so the better real cards are chosen first. Structural axes
// (untapped > typed dual > rare) match expert consensus; on top of that, metagame
// play-rate among winning decks breaks ties toward what pros actually run — the
// most reliable signal for choosing between same-color duals, and the ONLY signal
// for utility lands the castability model can't see. This decides *which* card
// fills a slot the color math already justified — not how many lands.
export function landQuality(land) {
  let q = 0;
  if (!land.tapped) q += 100;                                   // untapped is king
  if ((land.type || "").includes("—") && BASIC_TYPES.test(land.type)) q += 20; // typed dual
  if (land.rarity === "rare" || land.rarity === "mythic") q += 5;
  q += POPULARITY_WEIGHT * (_popularity[land.name]?.score || 0); // metagame play-rate
  return q;
}

// Selectable objectives. `key` is the model variable the solver optimizes; the
// per-land coefficient for that key is set in buildLandModel. Each objective
// variable is distinct from the constraint variables (total/taps) so it can fold
// in an off-color penalty without disturbing the constraints.
export const OBJECTIVES = {
  untapped: { label: "Most untapped sources", opType: "max", key: "obj_untapped" },
  taplands: { label: "Fewest tapped lands",   opType: "min", key: "obj_taps" },
  lands:    { label: "Fewest total lands",    opType: "min", key: "obj_total" },
};

// Per-off-color penalty folded into every objective. A land's "off-colors" are
// the colors it makes that the deck doesn't need: wasted fixing. Counting only
// *needed* colors (not every color a land taps for) plus this penalty stops the
// solver from loading up on five-color/utility lands in a two- or three-color
// deck — the same correction the greedy recommender makes. Kept small so it only
// decides between options the primary objective ties on (e.g. a focused dual vs a
// rainbow land that both add the needed colors).
const OFF_PENALTY = 0.5;

// Lazy-load the vendored solver. In the browser it injects a classic <script>
// that sets window.solver; in Node a test can pre-set globalThis.solver and this
// returns it without touching the DOM.
let _solverPromise = null;
function loadSolver() {
  if (typeof globalThis !== "undefined" && globalThis.solver) return Promise.resolve(globalThis.solver);
  if (_solverPromise) return _solverPromise;
  _solverPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = new URL("./vendor/lp-solver.js", import.meta.url).href;
    s.onload = () => (globalThis.solver ? resolve(globalThis.solver) : reject(new Error("optimizer failed to initialize")));
    s.onerror = () => reject(new Error("couldn't load the optimizer"));
    document.head.appendChild(s);
  });
  return _solverPromise;
}

// Reduce the land pool to what the ILP needs, grouped by (colors, tapped, basic)
// signature. Lands with the same signature are interchangeable *in the model*, so
// we keep one solver variable per signature — that keeps the integer program tiny
// and fast. Crucially, the group records all its member card names so its copy cap
// reflects real capacity (4 per distinct non-basic) and the solution can be
// expanded back across concrete cards (see summarize). Off-color and colorless
// lands are dropped (they can't satisfy a needed-color minimum). Members are
// name-sorted for deterministic output.
const BASIC_TYPE_LIST = ["Plains", "Island", "Swamp", "Mountain", "Forest"];
// Basic land types a land has (from "Land — Island Mountain"), used both to satisfy
// a Verge's type gate and to know which lands provide a given type.
function basicTypesOf(land) {
  const sub = (land.type || "").split("—")[1] || "";
  return BASIC_TYPE_LIST.filter((t) => sub.includes(t));
}

export function candidatePool(requirements, lands) {
  const needed = new Set(COLORS.filter((c) => (requirements[c] || 0) > 0));
  const groups = new Map();
  for (const land of [...lands].sort((a, b) => a.name.localeCompare(b.name))) {
    const colors = COLORS.filter((c) => (land.colors || []).includes(c));
    if (!colors.some((c) => needed.has(c))) continue; // colorless / off-color lands can't help a color min
    const gated = COLORS.filter((c) => (land.gatedColors || []).includes(c)); // Verge: gated on a basic type
    // Verges are NOT interchangeable with true duals of the same colors, so the
    // gated color is part of the signature (keeps them in their own group).
    const sig = colors.join("") + "|" + (land.tapped ? "T" : "U") + "|" + (land.basic ? "B" : "N") + "|g" + gated.join("");
    let g = groups.get(sig);
    if (!g) {
      g = {
        name: land.name, colors, tapped: !!land.tapped, basic: !!land.basic, land, members: [],
        gated, typeGate: land.typeGate || [], needsBasic: !!land.needsBasic, types: basicTypesOf(land),
        reliable: colors.filter((c) => !gated.includes(c)), // colors available without the gate
      };
      groups.set(sig, g);
    }
    g.members.push({ name: land.name, q: landQuality(land) });
  }
  // Within each signature, order members best-first (quality desc, then name) so
  // summarize fills slots with the premium cards before the fringe ones; the
  // highest-quality member becomes the group's representative variable.
  for (const g of groups.values()) {
    g.members.sort((a, b) => b.q - a.q || a.name.localeCompare(b.name));
    g.members = g.members.map((m) => m.name);
    g.name = g.members[0];
  }
  return [...groups.values()];
}

// Cost contribution of a single land under each objective. The solver MINIMIZES
// total cost, so "rewards" are negative. Off-color production (colors the deck
// doesn't need) is always mildly penalized, so a focused dual beats a rainbow land
// when both cover the needed colors.
function landCost(objective, cand, neededCount, off) {
  const offPart = OFF_PENALTY * off;
  if (objective === "taplands") return (cand.tapped ? 1 : 0) + offPart; // fewest tapped
  if (objective === "lands") return 1 + offPart;                        // fewest total lands
  return -(cand.tapped ? 0 : neededCount) + offPart;                    // default: most untapped sources
}

// Build a jsLPSolver model. Pure + exported for testing.
//   { requirements, lands, landTarget, objective, taplandCap, demandWeights, shortfallWeight }
// Color requirements are SOFT: each needed color gets a shortfall variable that can
// fill its minimum at a steep, demand-weighted cost. So instead of running extra
// lands (or going infeasible) to force-cover a demanding color, the solver keeps to
// the land target and, when something must give, gives on the color the deck leans
// on least — `demandWeights` (per-color total colored pips) ranks that.
export function buildLandModel({ requirements, lands, landTarget, objective = "untapped", taplandCap = 9, demandWeights = {}, shortfallWeight = 1000 }) {
  const needed = new Set(COLORS.filter((c) => (requirements[c] || 0) > 0));
  const pool = candidatePool(requirements, lands);

  const variables = {};
  const ints = {};
  const constraints = {};

  // Per-color source minimums (made soft by the shortfall variables below).
  for (const c of COLORS) {
    if ((requirements[c] || 0) > 0) constraints["col_" + c] = { min: requirements[c] };
  }
  // Total lands: the recommended count is a hard cap. The untapped / taplands
  // objectives fill to exactly the target; "fewest total lands" may come in under
  // it (but never over) when fewer lands still cover every color.
  const pinTotal = objective !== "lands";
  if (landTarget) constraints.total = pinTotal ? { equal: landTarget } : { max: landTarget };
  // Tapland cap — except when we're already minimizing taplands.
  if (objective !== "taplands") constraints.taps = { max: taplandCap };

  pool.forEach((cand, i) => {
    // Reward a Verge as the full dual it becomes once its basic type is online, so
    // the solver prefers it like pros do. The color minimum still routes the gated
    // color through the support linkage below (col_ credit uses only the reliable
    // colors), so it can't be leaned on without the types.
    const neededCount = cand.colors.reduce((n, c) => n + (needed.has(c) ? 1 : 0), 0);
    const off = cand.colors.filter((c) => !needed.has(c)).length; // colors the deck doesn't need
    const v = {
      total: 1,                          // constraint: total land count
      taps: cand.tapped ? 1 : 0,         // constraint: tapland cap
      cost: landCost(objective, cand, neededCount, off),
    };
    for (const c of cand.reliable) if (constraints["col_" + c]) v["col_" + c] = 1;
    const capKey = "cap_" + i; // per-variable copy bound
    v[capKey] = 1;
    // A signature's real capacity is 4 per distinct non-basic card; basics are
    // effectively unlimited. This lets the solver request, say, 12 untapped dual
    // sources (expanded across 3 distinct cards in summarize) instead of being
    // capped at one card's 4 and forced onto rainbow lands.
    constraints[capKey] = { max: cand.basic ? Math.max(landTarget || 0, 40) : NONBASIC_MAX * cand.members.length };
    variables[cand.name] = v;
    ints[cand.name] = 1;
  });

  // Soft requirement slack: one shortfall variable per needed color satisfies that
  // color's minimum at cost shortfallWeight × demand. shortfallWeight dwarfs any
  // land-shape term, so the solver only shorts a color when the land cap (and
  // tapland cap) physically prevent covering it — and the demand weight steers that
  // unavoidable shortfall onto the lowest-demand color first.
  for (const c of COLORS) {
    if (!constraints["col_" + c]) continue;
    variables["short_" + c] = { ["col_" + c]: 1, cost: shortfallWeight * Math.max(1, demandWeights[c] || 1) };
    ints["short_" + c] = 1;
  }

  // Gated-color credit: a gated color only counts up to how many lands enable it.
  // Two gates share this machinery:
  //   Verge      — enabled by lands of a matching basic TYPE (typed duals included).
  //   Check land — enabled by actual BASIC lands (the Marvel cycle: taps for {C}
  //                otherwise). Without basics it contributes no colored sources.
  // Model it as an aux variable per (land, gated color):
  //   credit ≤ this land's copies   AND   credit ≤ Σ(enabling lands)
  // and route that credit (not the land itself) into the color minimum, so the
  // solver only leans on the gated color when the build actually supplies enablers.
  pool.forEach((cand, i) => {
    if (!cand.gated.length || (!cand.typeGate.length && !cand.needsBasic)) return;
    const supporters = cand.needsBasic
      ? pool.filter((p) => p.basic)
      : pool.filter((p) => p.types.some((t) => cand.typeGate.includes(t)));
    for (const c of cand.gated) {
      if (!constraints["col_" + c]) continue; // gated color not needed
      const aux = `vcredit_${i}_${c}`;
      const leCopies = `vle_copies_${i}_${c}`;
      const leSupport = `vle_supp_${i}_${c}`;
      constraints[leCopies] = { min: 0 };   // verge_copies − credit ≥ 0
      constraints[leSupport] = { min: 0 };  // Σ supporters − credit ≥ 0
      variables[cand.name][leCopies] = (variables[cand.name][leCopies] || 0) + 1;
      for (const s of supporters) variables[s.name][leSupport] = (variables[s.name][leSupport] || 0) + 1;
      variables[aux] = { ["col_" + c]: 1, [leCopies]: -1, [leSupport]: -1 };
      ints[aux] = 1;
    }
  });

  return { optimize: "cost", opType: "min", constraints, variables, ints, _pool: pool };
}

// Turn a solver solution into the same shape recommend() returns, so the UI can
// render either interchangeably.
export function summarize(model, solution, requirements) {
  const counts = {};
  const sources = {};
  for (const c of COLORS) sources[c] = 0;
  let total = 0, taplands = 0;
  model._pool.forEach((cand, idx) => {
    let n = Math.round(solution[cand.name] || 0);
    if (n <= 0) return;
    total += n;
    if (cand.tapped) taplands += n;
    // Reliable colors are always produced. A Verge's gated color counts only up to
    // the credit the solver could enable (lands of a matching basic type in the
    // build) — so an unsupported gated color correctly reads as a shortfall, not a
    // phantom source.
    for (const c of cand.reliable) sources[c] += n;
    for (const c of cand.gated) sources[c] += Math.round(solution[`vcredit_${idx}_${c}`] || 0);
    // Expand the signature's count back onto concrete cards: basics take any
    // number; each distinct non-basic card takes at most 4.
    if (cand.basic) {
      counts[cand.members[0]] = (counts[cand.members[0]] || 0) + n;
    } else {
      for (const name of cand.members) {
        if (n <= 0) break;
        const take = Math.min(NONBASIC_MAX, n);
        counts[name] = (counts[name] || 0) + take;
        n -= take;
      }
    }
  });
  const shortfall = {};
  for (const c of COLORS) {
    const d = (requirements[c] || 0) - sources[c];
    if (d > 0) shortfall[c] = d;
  }
  return { counts, sources, total, taplands, shortfall, feasible: !!solution.feasible && total > 0 };
}

// Full path: load solver, build model, solve, summarize.
export async function optimizeManabase(opts) {
  const solver = await loadSolver();
  const model = buildLandModel(opts);
  const solution = solver.Solve(model);
  const res = summarize(model, solution, opts.requirements);
  res.objective = opts.objective || "untapped";
  return res;
}

// Land-count window the "battle-tested" option explores, anchored on the count
// regression (recommendLandCount). The regression is already a strong predictor of
// the pros' counts, so the simulator only gets a TIGHT band to nudge within: a land
// under (a lean curve that doesn't need it) to two over (a bomb-topped curve the
// avg-MV regression slightly under-counts). The band is intentionally narrow because
// the simulator models screw but not flood and so can't be trusted to pick the count
// from scratch — it refines the regression, it doesn't replace it.
const BAND_DOWN = 1, BAND_UP = 2;
function sweepRange(landTarget) {
  const t = landTarget || 24;
  const counts = [];
  for (let c = Math.max(15, t - BAND_DOWN); c <= Math.min(27, t + BAND_UP); c++) counts.push(c);
  return counts;
}

// The simulator models mana SCREW and wrong colours, but not FLOOD — drawing one
// more land never lowers its castability score, so on its own it would always pick
// the most lands. This is the missing counterweight: castability we *demand* per
// extra land beyond the proven count regression. A land past the regression count
// must buy at least this much simulated castability to be worth the flood risk it
// adds. (Going under the regression isn't penalized here — the sim's own screw term
// already punishes it.) TIE_EPS treats near-equal scores as ties so we break toward
// the leaner, faster build.
//
// 0.06 (a land must buy ≥6% worst-spell castability to be added) was calibrated
// against the 11 pro decks in tests/fixtures. At this level the simulator
// discriminates: it leans curve-topped decks (control, and aggro with a clunky top
// end) up toward the consistency the avg-MV regression slightly under-counts, trims
// combo decks whose key piece raw lands can't help, and leaves true aggro lean —
// landing within ~1.4 lands of the pros on average (matching the regression's own
// accuracy) while never over-counting by more than the band allows.
const FLOOD_PER_LAND = 0.06;
const TIE_EPS = 0.005;

/**
 * "Battle-tested" recommendation: the sim-in-the-loop option.
 *
 * The ILP is a fast feasibility/shape engine; the Monte-Carlo simulator is the
 * truth oracle for "do I actually cast my curve, screw included." Here they're
 * married: solve candidate bases across a band of land counts (plus all three
 * objectives at the regression target for shape variety), simulate each, and pick
 * the build with the best screw-vs-flood SCORE — simulated castability minus a flood
 * penalty for running more lands than the count regression recommends. The shape is
 * chosen by what actually casts best in thousands of games, not by a source-count
 * proxy; the count stays near the proven regression but the deck can earn extra
 * lands (a bomb-topped control curve) or shed them (a lean aggro curve) when the
 * simulation justifies it.
 *
 * `simulate(buildLands, deckSize, trials) -> { overall }` is injected so this stays
 * decoupled from montecarlo.js and unit-testable with a stub.
 *
 * @returns {Promise<{rec: object, sim: object, score: number}|null>} the chosen
 *   build + its sim, or null if there's nothing to simulate / no feasible base.
 */
export async function battleTested(opts) {
  const { requirements, lands, landTarget, demandWeights = {}, spells, deckSize, simulate, trials = 4000, floodPerLand = FLOOD_PER_LAND } = opts;
  if (!spells || !spells.length || typeof simulate !== "function") return null;

  // 1) Candidate builds: a "most untapped sources" base at every land count in the
  //    band. We deliberately use ONLY this shape, not the fewest-taplands / fewest-
  //    total objectives. The simulator under-models taplands (only an all-tapped
  //    opening hand fails it — it can't see a turn-1 tapland's tempo cost), so left to
  //    score raw shapes it favours tapland-heavy fixing that pros reject. The untapped
  //    objective already encodes the right shape prior; here the sim + flood penalty
  //    decide only the COUNT across these pro-shaped builds.
  const jobs = sweepRange(landTarget).map((c) =>
    optimizeManabase({ requirements, lands, landTarget: c, objective: "untapped", demandWeights }));
  const recs = (await Promise.all(jobs.map((p) => p.catch(() => null)))).filter((r) => r && r.feasible && r.total > 0);
  if (!recs.length) return null;

  // 2) Dedupe identical builds (many counts/objectives collapse to the same lands),
  //    then simulate each on common draws (the injected simulate seeds its own RNG).
  const byName = new Map(lands.map((l) => [l.name, l]));
  const seen = new Set();
  const cands = [];
  for (const rec of recs) {
    const sig = Object.keys(rec.counts).sort().map((n) => n + ":" + rec.counts[n]).join(",");
    if (seen.has(sig)) continue;
    seen.add(sig);
    const buildLands = Object.keys(rec.counts).map((name) => {
      const l = byName.get(name) || {};
      return { colors: l.colors || [], tapped: !!l.tapped, basic: !!l.basic, needsBasic: !!l.needsBasic, slow: !!l.slow, count: rec.counts[name] };
    });
    cands.push({ rec, sim: simulate(buildLands, deckSize, trials) });
  }

  // 3) Score each build (castability minus flood penalty above the regression count)
  //    and take the best; break near-ties toward the leaner, less-tapped build.
  const anchor = landTarget || Math.min(...cands.map((c) => c.rec.total));
  for (const c of cands) c.score = c.sim.overall - floodPerLand * Math.max(0, c.rec.total - anchor);
  const top = Math.max(...cands.map((c) => c.score));
  const tied = cands
    .filter((c) => c.score >= top - TIE_EPS)
    .sort((a, b) => a.rec.total - b.rec.total || a.rec.taplands - b.rec.taplands);
  const pick = tied[0];
  pick.rec.objective = "battle";
  return pick;
}
