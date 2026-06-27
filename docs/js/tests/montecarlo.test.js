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

console.log(`\n${n} montecarlo tests passed`);
