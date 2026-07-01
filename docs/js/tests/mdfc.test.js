// Modal double-faced cards in the Monte-Carlo sim: pickOne (land//land,
// Pathway-style) face lock-in, backLand (spell//land) land-drop policy, and a
// seeded golden guarding bit-identical behavior for decks with neither.
// Run with: node docs/js/tests/mdfc.test.js
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

let n = 0;
const ok = (m) => { n++; console.log("ok -", m); };

// A WU Pathway: choose ONE untapped face when you play it, locked in after.
const PATHWAY = {
  pickOne: true,
  colors: ["W", "U"],   // top-level union (as build_data ships it)
  tapped: false,        // false because a face is untapped
  faces: [
    { name: "White face", colors: ["W"], tapped: false },
    { name: "Blue face", colors: ["U"], tapped: false },
  ],
};

// --- Golden regression: no pickOne / backLand -> bit-identical to the -------
// pre-MDFC simulator (values captured from the previous montecarlo.js with the
// same seed). Guards every code path the MDFC work touched.
{
  const spells = [
    { name: "W1", pips: { W: 1 }, mv: 1, qty: 4 },
    { name: "W4", pips: { W: 1 }, mv: 4, qty: 4 },
    { name: "WU2", pips: { W: 1, U: 1 }, mv: 2, qty: 4 },
    { name: "HYB", pips: {}, hybrids: [["W", "U"]], mv: 2, qty: 2 },
  ];
  const lands = [
    { colors: ["W"], tapped: false, basic: true, count: 8 },
    { colors: ["U"], tapped: false, basic: true, count: 6 },
    { colors: ["W", "U"], tapped: true, count: 4 },
    { colors: ["W", "U"], needsBasic: true, tapped: false, count: 3 },
    { colors: ["W", "U"], slow: true, tapped: false, count: 2 },
  ];
  const r = simulateDeck(spells, lands, 60, { trials: 3000, seed: 424242, drawCount: 5, fetchCount: 2 });
  assert.deepStrictEqual(r.bySpell, { W1: 0.963, W4: 0.812, WU2: 0.9433333333333334, HYB: 0.9893333333333333 });
  assert.strictEqual(r.overall, 0.812);
  assert.deepStrictEqual(r.keepRates, { 7: 0.8366666666666667, 6: 0.137, 5: 0.02266666666666667, 4: 0.0036666666666666666 });
  assert.strictEqual(r.mulliganRate, 0.16333333333333333);
  assert.deepStrictEqual(r.delayBySpell, {
    W1: 0.07933333333333334, W4: 0.4513333333333333, WU2: 0.13766666666666666, HYB: 0.018666666666666668,
  });
  ok("no pickOne/backLand -> bit-identical to the pre-MDFC simulator (seeded golden)");
}

// --- Pathway lock-in -----------------------------------------------------
// A heavy-W deck with a splash UU spell: face choices chase the deck's dominant
// white demand, so a pool of Pathways starves the double-blue spell in a way a
// pool of true WU duals never does. Both colors are demanded; the difference
// is pure lock-in.
{
  const spells = [
    { name: "WW", pips: { W: 2 }, mv: 2, qty: 12 },   // heavy white
    { name: "UU", pips: { U: 2 }, mv: 3, qty: 2 },    // blue splash
  ];
  const pathways = sim(spells, [{ ...PATHWAY, count: 24 }]);
  const duals = sim(spells, [{ colors: ["W", "U"], tapped: false, count: 24 }]);
  assert.ok(duals.bySpell["UU"] - pathways.bySpell["UU"] > 0.2,
    `lock-in starves the splash: pathway ${pathways.bySpell["UU"]} vs dual ${duals.bySpell["UU"]}`);
  assert.ok(duals.overall >= pathways.overall, "duals never worse overall");
  // The dominant color barely suffers: faces commit white first.
  assert.ok(pathways.bySpell["WW"] > 0.8,
    "the dominant color still casts: " + pathways.bySpell["WW"]);
  ok("Pathway lock-in hurts the off-demand color vs true duals (directional)");
}

// With balanced demand the chooser alternates faces, so Pathways still function
// as fixing for a gold two-drop (well above zero, at most as good as duals).
{
  const spells = [{ name: "WU2", pips: { W: 1, U: 1 }, mv: 2, qty: 4 }];
  const pathways = sim(spells, [{ ...PATHWAY, count: 24 }]);
  const duals = sim(spells, [{ colors: ["W", "U"], tapped: false, count: 24 }]);
  assert.ok(pathways.bySpell["WU2"] > 0.5,
    "balanced demand alternates faces: " + pathways.bySpell["WU2"]);
  assert.ok(pathways.bySpell["WU2"] <= duals.bySpell["WU2"],
    `a committed Pathway can't beat a true dual: ${pathways.bySpell["WU2"]} vs ${duals.bySpell["WU2"]}`);
  ok("balanced demand keeps Pathways functional (and never better than duals)");
}

// Per-face tapped is honored, and ties on color deficit prefer the untapped face.
{
  const spells = [{ name: "W1", pips: { W: 1 }, mv: 1, qty: 4 }];
  const mixed = sim(spells, [{
    pickOne: true, colors: ["W"], tapped: false, count: 24,
    faces: [
      { name: "Tapped W", colors: ["W"], tapped: true },
      { name: "Untapped W", colors: ["W"], tapped: false },
    ],
  }]);
  const plain = sim(spells, [{ colors: ["W"], tapped: false, count: 24 }]);
  assert.strictEqual(mixed.bySpell["W1"], plain.bySpell["W1"],
    "equal-deficit faces resolve to the untapped one");
  const allTapped = sim(spells, [{
    pickOne: true, colors: ["W"], tapped: true, count: 24,
    faces: [
      { name: "Tapped W", colors: ["W"], tapped: true },
      { name: "Tapped U", colors: ["U"], tapped: true },
    ],
  }]);
  assert.strictEqual(allTapped.bySpell["W1"], 0, "all-tapped faces can never cast on curve");
  ok("face tapped flags are honored; deficit ties prefer the untapped face");
}

// --- backLand (spell//land) land-drop policy --------------------------------
// A land-light deck running spell//land MDFCs misses fewer of the land drops a
// cast needs than the same deck whose extra spells have no land face.
{
  const spells = [{ name: "W4", pips: { W: 1 }, mv: 4, qty: 4 }];
  const lands = [{ colors: ["W"], tapped: false, basic: true, count: 18 }];
  const without = sim(spells, lands);
  const withBacks = sim(spells, lands, { backLands: [{ colors: ["W"], tapped: false, count: 6 }] });
  assert.ok(withBacks.bySpell["W4"] - without.bySpell["W4"] > 0.03,
    `backLands patch missed drops: ${withBacks.bySpell["W4"]} vs ${without.bySpell["W4"]}`);
  assert.ok(withBacks.delayBySpell["W4"] < without.delayBySpell["W4"],
    "and they shrink the average delay");
  ok("a land-light deck with backLand spells misses fewer land drops (directional)");
}

// A flipped backLand uses the back face's tapped flag: an enters-tapped back
// face can't provide the untapped source a turn-1 cast needs, an untapped one can.
{
  const spells = [{ name: "W1", pips: { W: 1 }, mv: 1, qty: 4 }];
  const tapped = sim(spells, [], { backLands: [{ colors: ["W"], tapped: true, count: 30 }] });
  assert.strictEqual(tapped.bySpell["W1"], 0, "tapped back faces never cast a 1-drop on curve");
  const untapped = sim(spells, [], { backLands: [{ colors: ["W"], tapped: false, count: 30 }] });
  assert.ok(untapped.bySpell["W1"] > 0.8,
    "untapped back faces save the drop: " + untapped.bySpell["W1"]);
  ok("flipped backLands enter with the back face's tapped flag and colors");
}

// backLand copies are SPELLS in hand: they don't count as lands for mulligan
// keeps, so an all-backLand deck mulligans like a landless one.
{
  const spells = [{ name: "W1", pips: { W: 1 }, mv: 1, qty: 4 }];
  const r = sim(spells, [], { backLands: [{ colors: ["W"], tapped: false, count: 30 }] });
  assert.ok(r.mulliganRate > 0.95, "no real lands -> mulligans to the floor: " + r.mulliganRate);
  ok("backLand copies are not lands for mulligan decisions");
}

console.log(`\n${n} mdfc tests passed`);
