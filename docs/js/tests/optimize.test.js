// Tests for the ILP optimizer (optimize.js).
//
// The vendored solver is a browser bundle (sets window.solver). To exercise the
// real solver in Node we shim a global `window` and eval the bundle once, which
// populates globalThis.solver — exactly what optimize.js's loadSolver() looks for
// first, so optimizeManabase() runs without a DOM.

import fs from "fs";
import assert from "assert";
import { buildLandModel, candidatePool, summarize, optimizeManabase, OBJECTIVES } from "../optimize.js";

// --- load the vendored solver into globalThis.solver -----------------------
const bundle = fs
  .readFileSync(new URL("../vendor/lp-solver.js", import.meta.url), "utf8")
  .replace(/^\/\* jsLPSolver[\s\S]*?\*\/\n/, ""); // strip our banner only
// Keep the bundle's leading `"object"==typeof exports&&(...)` clause: under
// indirect eval `exports` is undefined so it short-circuits, but it provides the
// expression context that makes the trailing IIFE actually invoke.
globalThis.window = globalThis; // bundle does: "object"==typeof window ? window.solver = ...
(0, eval)(bundle);
assert.ok(globalThis.solver && typeof globalThis.solver.Solve === "function", "solver loaded");

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("ok - " + name); passed++; };

// A compact, deterministic land pool for a U/B deck.
const LANDS = [
  { name: "UB Dual",        colors: ["U", "B"], tapped: false, basic: false },
  { name: "UB Tapland",     colors: ["U", "B"], tapped: true,  basic: false },
  { name: "Island",         colors: ["U"],      tapped: false, basic: true },
  { name: "Swamp",          colors: ["B"],      tapped: false, basic: true },
  { name: "Mountain",       colors: ["R"],      tapped: false, basic: true }, // off-color, must be pruned
  { name: "Wastes",         colors: [],         tapped: false, basic: false }, // colorless, must be pruned
];
const REQ = { W: 0, U: 10, B: 10, R: 0, G: 0 };

// --- pool pruning ----------------------------------------------------------
const pool = candidatePool(REQ, LANDS);
ok("pool drops off-color and colorless lands", !pool.some((c) => c.name === "Mountain" || c.name === "Wastes"));
ok("pool keeps both tapped and untapped UB duals", pool.filter((c) => c.colors.join("") === "UB").length === 2);

// --- model shape -----------------------------------------------------------
const model = buildLandModel({ requirements: REQ, lands: LANDS, landTarget: 24, objective: "untapped" });
ok("model has per-color minimum constraints", model.constraints.col_U.min === 10 && model.constraints.col_B.min === 10);
ok("model pins total for the untapped objective", model.constraints.total.equal === 24);
ok("model marks land variables integer", Object.keys(model.ints).length === pool.length);

// --- end to end: maximize untapped ----------------------------------------
async function run() {
  const untapped = await optimizeManabase({ requirements: REQ, lands: LANDS, landTarget: 24, objective: "untapped" });
  ok("untapped: feasible", untapped.feasible);
  ok("untapped: hits the land target exactly", untapped.total === 24);
  ok("untapped: meets both color minimums", untapped.sources.U >= 10 && untapped.sources.B >= 10);
  ok("untapped: no shortfall", Object.keys(untapped.shortfall).length === 0);
  ok("untapped: prefers untapped lands (zero taplands available unneeded)", untapped.taplands === 0);

  // Fewest total lands: should run fewer than the 24 target while still legal.
  const lean = await optimizeManabase({ requirements: REQ, lands: LANDS, landTarget: 24, objective: "lands" });
  ok("lands: feasible", lean.feasible);
  ok("lands: meets color minimums", lean.sources.U >= 10 && lean.sources.B >= 10);
  ok("lands: runs no more than the target", lean.total <= 24);

  // Fewest taplands: with untapped duals available, should use zero taplands.
  const fast = await optimizeManabase({ requirements: REQ, lands: LANDS, landTarget: 24, objective: "taplands" });
  ok("taplands: feasible and uses no tapped lands", fast.feasible && fast.taplands === 0);

  // Infeasible: requiring 30 of each color in a 24-land base can't be met.
  const hard = await optimizeManabase({ requirements: { W: 0, U: 30, B: 30, R: 0, G: 0 }, lands: LANDS, landTarget: 24, objective: "untapped" });
  ok("infeasible target reported as not feasible", !hard.feasible);

  ok("OBJECTIVES expose three labeled goals", Object.keys(OBJECTIVES).length === 3);

  console.log(`\n${passed} optimizer tests passed`);
}
run().catch((e) => { console.error(e); process.exit(1); });
