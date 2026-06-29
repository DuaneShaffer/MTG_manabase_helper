import assert from "node:assert";
import { simulateDeck } from "../montecarlo.js";

// Seeded RNG (mulberry32) so these tests are deterministic, not flaky.
function seeded(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const sim = (spells, lands, opts = {}) =>
  simulateDeck(spells, lands, 60, { trials: 4000, rng: seeded(12345), ...opts });

const W1 = { name: "W one-drop", pips: { W: 1 }, mv: 1 };
const W4 = { name: "W four-drop", pips: { W: 1 }, mv: 4 };
const WU2 = { name: "WU two-drop", pips: { W: 1, U: 1 }, mv: 2 };
let n = 0;
const ok = (m) => { n++; console.log("ok -", m); };

// All-tapped lands can never cast on curve (the last drop is tapped).
{
  const r = sim([W1], [{ colors: ["W"], tapped: true, count: 24 }]);
  assert.strictEqual(r.bySpell["W one-drop"], 0, "all-tapped -> 0% on curve");
  ok("all-tapped lands give 0% on-curve");
}

// Color screw: a WU card with only W lands can never pay U.
{
  const r = sim([WU2], [{ colors: ["W"], tapped: false, count: 24 }]);
  assert.strictEqual(r.bySpell["WU two-drop"], 0, "no blue sources -> 0%");
  ok("color screw (missing a color) gives 0%");
}

// Mana screw is real on a 4-drop: high but genuinely < 100% (you can flood/miss drops).
{
  const r = sim([W4], [{ colors: ["W"], tapped: false, count: 17 }]);
  assert.ok(r.bySpell["W four-drop"] > 0.4 && r.bySpell["W four-drop"] < 1.0,
    "4-drop reflects screw: " + r.bySpell["W four-drop"]);
  ok("higher-curve card shows real mana-screw risk (<100%)");
}

// More lands -> higher castability for a card that can be land-screwed.
{
  const few = sim([W4], [{ colors: ["W"], tapped: false, count: 15 }]);
  const many = sim([W4], [{ colors: ["W"], tapped: false, count: 25 }]);
  assert.ok(many.bySpell["W four-drop"] > few.bySpell["W four-drop"], "more lands -> higher");
  ok("more lands raises castability");
}

// Check land (needsBasic): makes its colors only with a basic in play, so a deck
// of nothing but check lands can never pay a colored pip — but a basic turns them on.
{
  const noBasic = sim([WU2], [{ colors: ["U", "W"], needsBasic: true, tapped: false, count: 24 }]);
  assert.strictEqual(noBasic.bySpell["WU two-drop"], 0, "check lands, no basic -> colorless -> 0%");
  ok("check lands with no basic in play can't pay colored pips");

  const withBasics = sim([WU2], [
    { colors: ["U", "W"], needsBasic: true, tapped: false, count: 16 },
    { colors: ["W"], basic: true, tapped: false, count: 4 },
    { colors: ["U"], basic: true, tapped: false, count: 4 },
  ]);
  assert.ok(withBasics.bySpell["WU two-drop"] > 0.3,
    "basics turn the check lands on: " + withBasics.bySpell["WU two-drop"]);
  ok("a basic in play turns the check lands on");
}

// Slow land: tapped until you control two or more other lands, so a turn-2 spell
// off only slow lands casts on curve less often than off true untapped lands —
// but a turn-4 spell is unaffected (you always control >=2 other lands by then).
{
  const slow2 = sim([WU2], [{ colors: ["U", "W"], slow: true, tapped: false, count: 24 }]);
  const fast2 = sim([WU2], [{ colors: ["U", "W"], tapped: false, count: 24 }]);
  assert.ok(slow2.bySpell["WU two-drop"] < fast2.bySpell["WU two-drop"],
    `slow < untapped for a 2-drop: ${slow2.bySpell["WU two-drop"]} vs ${fast2.bySpell["WU two-drop"]}`);
  ok("slow lands lower on-curve odds for a turn-2 spell");

  const slow4 = sim([W4], [{ colors: ["W"], slow: true, tapped: false, count: 24 }]);
  const fast4 = sim([W4], [{ colors: ["W"], tapped: false, count: 24 }]);
  assert.ok(Math.abs(slow4.bySpell["W four-drop"] - fast4.bySpell["W four-drop"]) < 0.01,
    `slow ~= untapped for a 4-drop: ${slow4.bySpell["W four-drop"]} vs ${fast4.bySpell["W four-drop"]}`);
  ok("slow lands don't penalize a turn-4 spell (>=2 other lands by then)");
}

// "untapBasic" land (enters tapped unless you control a basic): with no basic in the
// build every copy is a tapland, so a deck of only these can't cast on curve; adding
// basics untaps them. The simulator decides this per game off the real board state,
// which is why the recommender (no board) still treats them as plain taplands.
{
  const noBasic = sim([WU2], [{ colors: ["U", "W"], tapped: true, untapBasic: true, count: 24 }]);
  assert.strictEqual(noBasic.bySpell["WU two-drop"], 0, "untapBasic, no basic -> all tapped -> 0%");
  ok("untapBasic lands stay tapped with no basic in play");

  const withBasic = sim([WU2], [
    { colors: ["U", "W"], tapped: true, untapBasic: true, count: 16 },
    { colors: ["W"], basic: true, tapped: false, count: 4 },
    { colors: ["U"], basic: true, tapped: false, count: 4 },
  ]);
  assert.ok(withBasic.bySpell["WU two-drop"] > 0.3,
    "a basic in play untaps them: " + withBasic.bySpell["WU two-drop"]);
  ok("a basic in play untaps the untapBasic lands");
}

// On the draw (onPlay:false) you see one extra card by each cast turn, so castability
// can only rise — and on higher curves it rises a lot. This invariant underpins the
// play/draw toggle and the "cut a land on the draw" sideboard guidance.
{
  const lands = [{ colors: ["W"], tapped: false, count: 24 }];
  const play = sim([W4], lands, { onPlay: true });
  const draw = sim([W4], lands, { onPlay: false });
  assert.ok(draw.bySpell["W four-drop"] >= play.bySpell["W four-drop"],
    `on the draw >= on the play: ${draw.bySpell["W four-drop"]} vs ${play.bySpell["W four-drop"]}`);
  // And it's a real gap on a 4-drop at a modest land count, not a rounding wobble.
  const tight = [{ colors: ["W"], tapped: false, count: 16 }];
  const p2 = sim([W4], tight, { onPlay: true }).bySpell["W four-drop"];
  const d2 = sim([W4], tight, { onPlay: false }).bySpell["W four-drop"];
  assert.ok(d2 - p2 > 0.02, `draw beats play by a real margin: +${((d2 - p2) * 100).toFixed(1)}pts`);
  ok("on the draw raises castability (and meaningfully on higher curves)");
}

// A numeric `seed` makes a run fully reproducible.
{
  const opts = { trials: 2000, seed: 99 };
  const a = simulateDeck([W4], [{ colors: ["W"], tapped: false, count: 17 }], 60, opts);
  const b = simulateDeck([W4], [{ colors: ["W"], tapped: false, count: 17 }], 60, opts);
  assert.strictEqual(a.bySpell["W four-drop"], b.bySpell["W four-drop"], "same seed -> identical");
  ok("a seeded simulation run is reproducible");
}

// Common random numbers: per-trial seeding gives a LOWER-variance build-vs-build
// comparison than a single shared RNG stream (which desyncs once two builds mulligan
// at different rates). Estimate (B - A) across several seeds under both; CRN's spread
// should be smaller.
{
  const A = [{ colors: ["W"], tapped: false, count: 16 }];   // screw-prone
  const B = [{ colors: ["W"], tapped: false, count: 24 }];   // more lands, different mulligan rate
  // Well-spread, high-entropy seeds: mulberry32 reseeded per trial needs them —
  // tiny sequential seeds (1,2,3…) correlate and make the variance estimate unreliable.
  const SEEDS = Array.from({ length: 24 }, (_, i) => ((i * 2654435761) >>> 0) ^ 0x1234567);
  const variance = (xs) => { const m = xs.reduce((p, q) => p + q, 0) / xs.length; return xs.reduce((p, q) => p + (q - m) ** 2, 0) / xs.length; };
  const sub = (oB, oA) => oB.bySpell["W four-drop"] - oA.bySpell["W four-drop"];
  const diffCRN = SEEDS.map((s) =>
    sub(simulateDeck([W4], B, 60, { trials: 3000, seed: s }), simulateDeck([W4], A, 60, { trials: 3000, seed: s })));
  const diffShared = SEEDS.map((s) =>
    sub(simulateDeck([W4], B, 60, { trials: 3000, rng: seeded(s) }), simulateDeck([W4], A, 60, { trials: 3000, rng: seeded(s) })));
  assert.ok(variance(diffCRN) < variance(diffShared),
    `per-trial CRN variance ${variance(diffCRN).toExponential(2)} should beat shared-stream ${variance(diffShared).toExponential(2)}`);
  ok("per-trial common random numbers lower the build-vs-build comparison variance");
}

console.log(`\n${n} montecarlo tests passed`);
