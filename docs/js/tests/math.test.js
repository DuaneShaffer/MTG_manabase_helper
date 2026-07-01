// Node test verifying the JS math modules reproduce the Python implementation's
// exact outputs. Run with:  node docs/js/tests/math.test.js
import assert from "node:assert";

import { parseCost, manaValue, colorsInCost, costConstraints } from "../mana.js";
import {
  comb,
  cardsSeen,
  thresholdFor,
  assumedLandCount,
  assumedDeckSize,
  conditionalProb,
  castableProbability,
  sourcesNeeded,
  grade,
  multivariateCastable,
  hypergeomAtLeast,
  drawOddsByTurn,
} from "../hypergeometric.js";
import { sourcesFor, requirementsForCosts, requirementsForCards } from "../requirements.js";
import { recommendLandCount } from "../recommend.js";

let passed = 0;
function check(desc, fn) {
  fn();
  passed += 1;
  console.log("ok - " + desc);
}

// --- sources_needed goldens (pips 1..4, mv pips..6) ------------------------
// From: ./bin/python -c "...sources_needed(p,m) for p in 1..4 for m in p..6"
const SOURCES_GOLDEN = {
  "1,1": 16, "1,2": 13, "1,3": 12, "1,4": 10, "1,5": 9, "1,6": 9,
  "2,2": 21, "2,3": 18, "2,4": 16, "2,5": 15, "2,6": 13,
  "3,3": 23, "3,4": 21, "3,5": 19, "3,6": 17,
  "4,4": 24, "4,5": 22, "4,6": 20,
};
check("sourcesNeeded matches all Python goldens", () => {
  for (let p = 1; p <= 4; p++) {
    for (let m = p; m <= 6; m++) {
      const key = `${p},${m}`;
      const got = sourcesNeeded(p, m);
      assert.strictEqual(got, SOURCES_GOLDEN[key], `sourcesNeeded(${p},${m}) = ${got}, want ${SOURCES_GOLDEN[key]}`);
    }
  }
});

// --- requirements_for_costs goldens ----------------------------------------
check("requirements gold {1}{W}{U} -> W:13 U:13", () => {
  const req = requirementsForCosts(["{1}{W}{U}"]);
  assert.deepStrictEqual(req, { W: 13, U: 13, B: 0, R: 0, G: 0 });
});

check("requirements max white {W} vs {W}{W}{W} -> W:23", () => {
  const req = requirementsForCosts(["{W}", "{W}{W}{W}"]);
  assert.deepStrictEqual(req, { W: 23, U: 0, B: 0, R: 0, G: 0 });
});

// requirementsForCards accepts mana_cost-keyed dicts too
check("requirementsForCards accepts mana_cost key", () => {
  const req = requirementsForCards([{ mana_cost: "{1}{W}{U}" }]);
  assert.deepStrictEqual(req, { W: 13, U: 13, B: 0, R: 0, G: 0 });
});

// --- parse: multi-digit generic & colorless -------------------------------
check("multi-digit generic {10}{W} parses to 10 generic + 1 W", () => {
  const { generic, colored } = parseCost("{10}{W}");
  assert.strictEqual(generic, 10);
  assert.strictEqual(colored.W, 1);
  assert.strictEqual(manaValue("{10}{W}"), 11);
});

check("colorless {C}{W} folds C into generic (mv 2, 1 white pip)", () => {
  const { generic, colored } = parseCost("{C}{W}");
  assert.strictEqual(generic, 1); // C -> generic
  assert.strictEqual(colored.W, 1);
  assert.strictEqual(manaValue("{C}{W}"), 2);
  // not gold: only one true color
  const cc = costConstraints("{C}{W}");
  assert.strictEqual(cc.W.gold, false);
  assert.strictEqual(cc.W.pips, 1);
});

check("colorsInCost returns distinct WUBRG set", () => {
  const set = colorsInCost("{1}{W}{U}{U}");
  assert.deepStrictEqual([...set].sort(), ["U", "W"]);
});

check("X/Y/Z and hybrid handling", () => {
  // X contributes 0
  assert.strictEqual(manaValue("{X}{W}"), 1);
  // two-color hybrid {W/U}: a hybrid pair, no hard color, +1 to MV
  const { generic, colored, hybrid } = parseCost("{1}{W/U}");
  assert.strictEqual(generic, 1);
  assert.deepStrictEqual(hybrid, [["W", "U"]]);
  assert.strictEqual(colored.W, 0);
  assert.strictEqual(manaValue("{1}{W/U}"), 2);
  // {W/U} hard-needs no specific color (colorsInCost excludes hybrids)
  assert.strictEqual(colorsInCost("{W/U}").size, 0);
  // twobrid {2/W} -> generic 2 (no color pressure); Phyrexian {W/P} -> generic 1
  assert.strictEqual(parseCost("{2/W}").generic, 2);
  assert.strictEqual(manaValue("{2/W}"), 2);
  assert.strictEqual(parseCost("{W/P}").generic, 1);
  const cc = costConstraints("{1}{W}{U}");
  assert.strictEqual(cc.W.gold, true); // two distinct colors -> gold
  assert.strictEqual(cc.U.gold, true);
});

check("hybrid requirement leans on the deck's invested color", () => {
  // Heavy white -> {W/U} casts off white: white pressure, zero blue demand.
  const req = requirementsForCosts(["{W}{W}{W}", "{W}{W}", "{W/U}{W/U}"]);
  assert.strictEqual(req.U, 0);
  assert.ok(req.W > 0, `expected white demand, got ${req.W}`);
});

// --- castable_probability within 1e-6 of Python floats ---------------------
// From: castable_probability(2,3,18) and (2,3,10)
check("castableProbability(2,3,18) ~= 0.9237677187542386", () => {
  const got = castableProbability(2, 3, 18);
  assert.ok(Math.abs(got - 0.9237677187542386) < 1e-6, `got ${got}`);
});
check("castableProbability(2,3,10) ~= 0.5456708588921102", () => {
  const got = castableProbability(2, 3, 10);
  assert.ok(Math.abs(got - 0.5456708588921102) < 1e-6, `got ${got}`);
});
check("castableProbability pips<=0 -> 1.0", () => {
  assert.strictEqual(castableProbability(0, 3, 18), 1.0);
});

// --- helper functions ------------------------------------------------------
check("cardsSeen on play / on draw", () => {
  assert.strictEqual(cardsSeen(3, true), 9);
  assert.strictEqual(cardsSeen(3, false), 10);
});
check("thresholdFor sliding + clamp", () => {
  assert.ok(Math.abs(thresholdFor(3) - 0.92) < 1e-12);
  assert.strictEqual(thresholdFor(20), 0.99); // clamped
});
check("assumedLandCount scaling", () => {
  assert.strictEqual(assumedLandCount(60), 25);
  assert.strictEqual(assumedLandCount(40), 17); // round(16.66..) = 17
  assert.strictEqual(assumedLandCount(99), 41); // round(41.25) = 41
});
// --- assumedDeckSize (spell-only lists model the intended final deck) ------
check("assumedDeckSize: 36 spells around a ~24-land curve is exactly 60", () => {
  // base = 19.59 + 1.90*2.32 = 23.998 -> 24 lands at 60 cards; 36 + 24 = 60.
  assert.strictEqual(assumedDeckSize(36, 2.32, 0), 60);
});
check("assumedDeckSize is a fixed point of the land regression", () => {
  for (const spells of [20, 30, 36, 40, 50, 60, 75]) {
    for (const avgMV of [1.5, 2, 2.5, 3, 3.5, 4, 5]) {
      for (const smooth of [0, 8]) {
        const d = assumedDeckSize(spells, avgMV, smooth);
        const want = Math.max(60, spells + recommendLandCount(avgMV, d, smooth));
        assert.strictEqual(d, want,
          `assumedDeckSize(${spells},${avgMV},${smooth}) = ${d}, not a fixed point (want ${want})`);
        assert.ok(d >= 60, `deck size ${d} below 60`);
      }
    }
  }
});
check("assumedDeckSize: more than a deck's worth of spells grows the deck", () => {
  const d = assumedDeckSize(50, 3, 0);
  assert.ok(d > 60, `50 spells should imply >60 cards, got ${d}`);
  assert.strictEqual(d, 50 + recommendLandCount(3, d, 0));
});
check("assumedDeckSize: empty list keeps the 60-card default", () => {
  assert.strictEqual(assumedDeckSize(0, 3, 0), 60);
  assert.strictEqual(assumedDeckSize(-1, 3, 0), 60);
});

check("comb exact BigInt", () => {
  assert.strictEqual(comb(5, 2), 10n);
  assert.strictEqual(comb(60, 30), 118264581564861424n);
  assert.strictEqual(comb(3, 5), 0n);
});
check("conditionalProb is used by castableProbability consistently", () => {
  const direct = conditionalProb(2, 3, 60, 25, 18, cardsSeen(3, true));
  assert.ok(Math.abs(direct - castableProbability(2, 3, 18)) < 1e-12);
});

// --- grade bands -----------------------------------------------------------
check("grade letters per band", () => {
  assert.strictEqual(grade(0.97).letter, "A");
  assert.strictEqual(grade(0.95).letter, "A");
  assert.strictEqual(grade(0.92).letter, "B");
  assert.strictEqual(grade(0.9).letter, "B");
  assert.strictEqual(grade(0.85).letter, "C");
  assert.strictEqual(grade(0.8).letter, "C");
  assert.strictEqual(grade(0.7).letter, "D");
  assert.strictEqual(grade(0.65).letter, "D");
  assert.strictEqual(grade(0.5).letter, "F");
  assert.strictEqual(grade(0.97).label, "Excellent");
  assert.strictEqual(grade(0.5).label, "Unreliable");
});

// --- sourcesFor adds +1 for gold ------------------------------------------
check("sourcesFor adds +1 for gold cards", () => {
  // {1}{W}{U}: each color pips=1, mv=3, gold=true.
  // sourcesNeeded(1,3)=12, +1 gold = 13 (matches requirements gold golden).
  assert.strictEqual(sourcesFor(1, 3, false), 12);
  assert.strictEqual(sourcesFor(1, 3, true), 13);
});

// --- multivariateCastable sanity check ------------------------------------
check("multivariateCastable bounded by single-color probabilities", () => {
  const pips = { W: 1, U: 1 };
  const sources = { W: 15, U: 15 };
  const p = multivariateCastable(pips, 3, sources, 60, 24, true);
  const pW = castableProbability(1, 3, 15, 60, 24, true);
  const pU = castableProbability(1, 3, 15, 60, 24, true);
  assert.ok(p > 0, `expected p>0, got ${p}`);
  assert.ok(p <= Math.min(pW, pU) + 1e-12, `expected p<=min(pW,pU); p=${p}, pW=${pW}, pU=${pU}`);
});
check("multivariateCastable falls back for 0/1 colors", () => {
  // 1 color -> equals castableProbability
  const one = multivariateCastable({ W: 2 }, 3, { W: 18 }, 60, null, true);
  assert.ok(Math.abs(one - castableProbability(2, 3, 18)) < 1e-12);
  // 0 colors -> 1.0
  assert.strictEqual(multivariateCastable({}, 3, {}, 60, null, true), 1.0);
});

// --- plain hypergeometric (draw-odds tool) matches Python goldens ----------
check("hypergeomAtLeast matches Python goldens", () => {
  assert.ok(Math.abs(hypergeomAtLeast(60, 4, 7, 1) - 0.3994996257446656) < 1e-12);
  assert.ok(Math.abs(hypergeomAtLeast(60, 25, 7, 1) - 0.9825882974857105) < 1e-12);
  assert.ok(Math.abs(drawOddsByTurn(60, 4, 2, 4, true) - 0.12578055307760927) < 1e-12);
});
check("hypergeomAtLeast edge cases", () => {
  assert.strictEqual(hypergeomAtLeast(60, 4, 7, 0), 1.0);   // k=0 -> certain
  assert.strictEqual(hypergeomAtLeast(60, 3, 7, 4), 0.0);   // k > successes -> 0
  assert.strictEqual(hypergeomAtLeast(40, 20, 3, 4), 0.0);  // k > sample -> 0
});
check("hypergeomAtLeast is monotonic in copies and turn", () => {
  assert.ok(hypergeomAtLeast(60, 8, 7, 1) > hypergeomAtLeast(60, 4, 7, 1));   // more copies
  assert.ok(drawOddsByTurn(60, 4, 1, 6, true) > drawOddsByTurn(60, 4, 1, 2, true)); // later turn
  assert.ok(drawOddsByTurn(60, 4, 1, 3, false) > drawOddsByTurn(60, 4, 1, 3, true)); // draw>play
});

console.log(`\nAll ${passed} checks passed.`);
