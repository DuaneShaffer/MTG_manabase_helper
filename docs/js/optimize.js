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
export function candidatePool(requirements, lands) {
  const needed = new Set(COLORS.filter((c) => (requirements[c] || 0) > 0));
  const groups = new Map();
  for (const land of [...lands].sort((a, b) => a.name.localeCompare(b.name))) {
    const colors = COLORS.filter((c) => (land.colors || []).includes(c));
    if (!colors.some((c) => needed.has(c))) continue; // colorless / off-color lands can't help a color min
    const sig = colors.join("") + "|" + (land.tapped ? "T" : "U") + "|" + (land.basic ? "B" : "N");
    let g = groups.get(sig);
    if (!g) {
      g = { name: land.name, colors, tapped: !!land.tapped, basic: !!land.basic, land, members: [] };
      groups.set(sig, g);
    }
    g.members.push(land.name);
  }
  return [...groups.values()];
}

// Build a jsLPSolver model. Pure + exported for testing.
//   { requirements, lands, landTarget, objective, taplandCap }
export function buildLandModel({ requirements, lands, landTarget, objective = "untapped", taplandCap = 9 }) {
  const obj = OBJECTIVES[objective] || OBJECTIVES.untapped;
  const needed = new Set(COLORS.filter((c) => (requirements[c] || 0) > 0));
  const pool = candidatePool(requirements, lands);

  const variables = {};
  const ints = {};
  const constraints = {};

  // Per-color source minimums.
  for (const c of COLORS) {
    if ((requirements[c] || 0) > 0) constraints["col_" + c] = { min: requirements[c] };
  }
  // Total lands: pinned to the target for the untapped / taplands objectives;
  // left free (and minimized) when the objective *is* "fewest total lands".
  const pinTotal = objective !== "lands";
  if (pinTotal && landTarget) constraints.total = { equal: landTarget };
  // Tapland cap — except when we're already minimizing taplands.
  if (objective !== "taplands") constraints.taps = { max: taplandCap };

  pool.forEach((cand, i) => {
    const neededCount = cand.colors.reduce((n, c) => n + (needed.has(c) ? 1 : 0), 0);
    const off = cand.colors.length - neededCount; // colors the deck doesn't need
    const v = {
      total: 1,                          // constraint: total land count
      taps: cand.tapped ? 1 : 0,         // constraint: tapland cap
      // objective accumulators (only the active one is optimized); each scores
      // needed colors only and is penalized for wasted off-colors.
      obj_untapped: (cand.tapped ? 0 : neededCount) - OFF_PENALTY * off,
      obj_taps: (cand.tapped ? 1 : 0) + OFF_PENALTY * off,
      obj_total: 1 + OFF_PENALTY * off,
    };
    for (const c of cand.colors) if (constraints["col_" + c]) v["col_" + c] = 1;
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

  return { optimize: obj.key, opType: obj.opType, constraints, variables, ints, _pool: pool };
}

// Turn a solver solution into the same shape recommend() returns, so the UI can
// render either interchangeably.
export function summarize(model, solution, requirements) {
  const counts = {};
  const sources = {};
  for (const c of COLORS) sources[c] = 0;
  let total = 0, taplands = 0;
  for (const cand of model._pool) {
    let n = Math.round(solution[cand.name] || 0);
    if (n <= 0) continue;
    total += n;
    if (cand.tapped) taplands += n;
    for (const c of cand.colors) sources[c] += n;
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
  }
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
