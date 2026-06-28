// Tests for the ILP optimizer (optimize.js).
//
// The vendored solver is a browser bundle (sets window.solver). To exercise the
// real solver in Node we shim a global `window` and eval the bundle once, which
// populates globalThis.solver — exactly what optimize.js's loadSolver() looks for
// first, so optimizeManabase() runs without a DOM.

import fs from "fs";
import assert from "assert";
import { buildLandModel, candidatePool, summarize, optimizeManabase, battleTested, OBJECTIVES } from "../optimize.js";

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
ok("model marks every land variable integer", pool.every((c) => model.ints[c.name] === 1));
ok("model adds a soft shortfall variable per needed color", model.ints.short_U === 1 && model.ints.short_B === 1);

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

  // Over-demanding: requiring 30 of each color in a 24-land base can't be met, so
  // the solver now returns a best-effort build at the cap with the gap as shortfall
  // (rather than reporting infeasible).
  const hard = await optimizeManabase({ requirements: { W: 0, U: 30, B: 30, R: 0, G: 0 }, lands: LANDS, landTarget: 24, objective: "untapped" });
  ok("over-demanding target: best-effort build at the cap", hard.feasible && hard.total === 24);
  ok("over-demanding target: reports the gap as shortfall", (hard.shortfall.U > 0 || hard.shortfall.B > 0));

  ok("OBJECTIVES expose three labeled goals", Object.keys(OBJECTIVES).length === 3);

  // --- Verge type-gating ----------------------------------------------------
  // A Verge makes its first color freely but its second (gated) color only if you
  // control a matching basic type. Need B; the only B source is a Verge gated on
  // Island/Swamp.
  const verge = { name: "UB Verge", colors: ["U", "B"], gatedColors: ["B"],
    typeGate: ["Island", "Swamp"], type: "Land", tapped: false, basic: false };
  const islandSupporter = { name: "Island", colors: ["U"], type: "Basic Land — Island", tapped: false, basic: true };

  // Need B (gated) with no land of a matching basic type in the pool → the verge
  // can't be leaned on for B, so that color shows up as shortfall.
  const noTypes = await optimizeManabase({ requirements: { W: 0, U: 0, B: 2, R: 0, G: 0 }, lands: [verge], landTarget: 2, objective: "untapped" });
  ok("verge alone can't supply its gated color (no enabling basic type)", (noTypes.sources.B || 0) === 0 && noTypes.shortfall.B === 2);

  // Need U+B; Islands satisfy U and also turn on the verge's gated B.
  const withTypes = await optimizeManabase({ requirements: { W: 0, U: 1, B: 2, R: 0, G: 0 }, lands: [verge, islandSupporter], landTarget: 6, objective: "untapped" });
  ok("verge supplies its gated color once a matching type is in the build",
    withTypes.feasible && (withTypes.counts["Island"] || 0) > 0 && (withTypes.counts["UB Verge"] || 0) > 0);

  // --- Check-land gating (Marvel cycle) ------------------------------------
  // A check land taps for {C} freely but its colors only with a basic in play,
  // so its colored output is gated on controlling an ACTUAL basic land.
  const bastion = { name: "Gleaming Bastion", colors: ["U", "W"], gatedColors: ["U", "W"],
    needsBasic: true, type: "Land", tapped: false, basic: false };
  const plains = { name: "Plains", colors: ["W"], type: "Basic Land — Plains", tapped: false, basic: true };
  const island = { name: "Island", colors: ["U"], type: "Basic Land — Island", tapped: false, basic: true };

  const noBasic = await optimizeManabase({ requirements: { W: 2, U: 2, B: 0, R: 0, G: 0 }, lands: [bastion], landTarget: 4, objective: "untapped" });
  ok("check land with no basic in the build is colorless (its color reads as shortfall)",
    (noBasic.sources.W || 0) === 0 && noBasic.shortfall.W === 2);

  const withBasic = await optimizeManabase({ requirements: { W: 2, U: 2, B: 0, R: 0, G: 0 }, lands: [bastion, plains, island], landTarget: 8, objective: "untapped" });
  ok("check land supplies its colors once the build runs basics",
    withBasic.feasible && withBasic.sources.W >= 2 && withBasic.sources.U >= 2
    && Object.keys(withBasic.shortfall).length === 0
    && (withBasic.counts["Gleaming Bastion"] || 0) > 0 && (withBasic.counts["Plains"] || 0) > 0);

  // The untapped objective must NOT pad excess slots with a check land when there's
  // no basic to turn it on (it taps for {C} only). With other untapped fixing
  // covering the colors, a chosen check land must come with basics.
  const dual = { name: "UW Dual", colors: ["U", "W"], type: "Land", tapped: false, basic: false };
  const pad = await optimizeManabase({ requirements: { W: 4, U: 4, B: 0, R: 0, G: 0 },
    lands: [dual, bastion, plains, island], landTarget: 17, objective: "untapped" });
  const padBastions = pad.counts["Gleaming Bastion"] || 0;
  const padBasics = (pad.counts["Plains"] || 0) + (pad.counts["Island"] || 0);
  ok("untapped objective won't pad with a check land that has no basics to enable it",
    padBastions === 0 || padBasics > 0);

  // --- Battle-tested: sim-in-the-loop, flood-anchored count selection -------
  // The simulator never penalizes flood, so its castability only rises with land
  // count. Battle-tested supplies the missing counterweight: a flood penalty above
  // the regression count, so a deck must EARN extra lands with real castability. We
  // inject a stub `simulate` keyed on total land count to drive both regimes.
  const battleSpells = [{ name: "x", pips: { U: 1, B: 1 }, mv: 2 }];
  const totalOf = (buildLands) => buildLands.reduce((n, l) => n + l.count, 0);
  const linearSim = (base, slope, cap) => (buildLands) => ({
    overall: Math.min(cap, base + slope * totalOf(buildLands)), bySpell: {}, trials: 1,
  });

  // Saturating curve (a lean aggro deck): castability is flat near the regression
  // count, so extra lands only incur the flood penalty — the pick stays at/under the
  // regression target rather than piling on lands.
  const aggro = await battleTested({
    requirements: REQ, lands: LANDS, landTarget: 22, spells: battleSpells, deckSize: 60,
    simulate: linearSim(0.6, 0.03, 0.95), floodPerLand: 0.02,
  });
  ok("battle-tested: a saturating curve doesn't flood past the regression count", aggro && aggro.rec.total <= 22);
  ok("battle-tested: returns the simulated score it chose on", aggro.sim && aggro.sim.overall >= 0.9);
  ok("battle-tested: still covers both colors", aggro.rec.sources.U >= 10 && aggro.rec.sources.B >= 10);

  // Strongly climbing curve (slope above the flood penalty — a bomb-topped deck that
  // keeps needing more lands): each extra land earns more castability than it costs
  // in flood, so the pick rises above the regression count (capped by the band).
  const control = await battleTested({
    requirements: REQ, lands: LANDS, landTarget: 16, spells: battleSpells, deckSize: 60,
    simulate: linearSim(0.4, 0.03, 1), floodPerLand: 0.02,
  });
  ok("battle-tested: a curve that keeps earning lands runs more than the target", control && control.rec.total > 16);

  // No spells / no simulate -> null, so callers fall back to the ILP options.
  const none = await battleTested({ requirements: REQ, lands: LANDS, landTarget: 22, spells: [], deckSize: 60, simulate: linearSim(0.6, 0.03, 0.95) });
  ok("battle-tested: returns null when there's nothing to simulate", none === null);

  console.log(`\n${passed} optimizer tests passed`);
}
run().catch((e) => { console.error(e); process.exit(1); });
