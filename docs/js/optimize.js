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
// per-land coefficient for that key is set in buildLandModel.
export const OBJECTIVES = {
  untapped: { label: "Most untapped sources", opType: "max", key: "untapped" },
  taplands: { label: "Fewest tapped lands",   opType: "min", key: "taps" },
  lands:    { label: "Fewest total lands",    opType: "min", key: "total" },
};

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

// Reduce the land pool to what the ILP needs: lands producing >=1 needed color,
// deduped by (colors, tapped, basic) signature — lands with the same signature
// are interchangeable in the model, so we keep one representative (first by name).
// This keeps the integer program small enough to solve instantly.
export function candidatePool(requirements, lands) {
  const needed = new Set(COLORS.filter((c) => (requirements[c] || 0) > 0));
  const seen = new Set();
  const out = [];
  for (const land of [...lands].sort((a, b) => a.name.localeCompare(b.name))) {
    const colors = COLORS.filter((c) => (land.colors || []).includes(c));
    if (!colors.some((c) => needed.has(c))) continue; // colorless / off-color lands can't help a color min
    const sig = colors.join("") + "|" + (land.tapped ? "T" : "U") + "|" + (land.basic ? "B" : "N");
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push({ name: land.name, colors, tapped: !!land.tapped, basic: !!land.basic, land });
  }
  return out;
}

// Build a jsLPSolver model. Pure + exported for testing.
//   { requirements, lands, landTarget, objective, taplandCap }
export function buildLandModel({ requirements, lands, landTarget, objective = "untapped", taplandCap = 9 }) {
  const obj = OBJECTIVES[objective] || OBJECTIVES.untapped;
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
  const pinTotal = obj.key !== "total";
  if (pinTotal && landTarget) constraints.total = { equal: landTarget };
  // Tapland cap — except when we're already minimizing taplands.
  if (obj.key !== "taps") constraints.taps = { max: taplandCap };

  pool.forEach((cand, i) => {
    const v = { total: 1, taps: cand.tapped ? 1 : 0, untapped: cand.tapped ? 0 : cand.colors.length };
    for (const c of cand.colors) if (constraints["col_" + c]) v["col_" + c] = 1;
    const capKey = "cap_" + i; // per-variable copy bound
    v[capKey] = 1;
    constraints[capKey] = { max: cand.basic ? Math.max(landTarget || 0, 40) : NONBASIC_MAX };
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
    const n = Math.round(solution[cand.name] || 0);
    if (n <= 0) continue;
    counts[cand.name] = n;
    total += n;
    if (cand.tapped) taplands += n;
    for (const c of cand.colors) sources[c] += n;
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
