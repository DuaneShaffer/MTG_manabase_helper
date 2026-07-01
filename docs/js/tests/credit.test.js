// Fractional nonland source credit (Karsten: dork ~0.5 source, rock ~0.75)
// and its use by the recommender. Run with: node docs/js/tests/credit.test.js
import assert from "node:assert";

import { nonlandSourceCredit, creditForSpell } from "../requirements.js";
import { creditAdjustedRequirements, recommend } from "../recommend.js";

let passed = 0;
function check(desc, fn) {
  fn();
  passed += 1;
  console.log("ok - " + desc);
}

const ELVES = { name: "Llanowar Elves", manaColors: ["G"], manaKind: "dork", mv: 1 };
const SIGNET = { name: "Azorius Signet", manaColors: ["W", "U"], manaKind: "rock", mv: 2 };
const LOCKET = { name: "Golgari Locket", manaColors: ["B", "G"], manaKind: "rock", cost: "{3}" }; // mv from cost
const BEAR = { name: "Grizzly Bears", cost: "{1}{G}" }; // not a producer

// --- nonlandSourceCredit: weights, per-copy scaling, multi-color credit -----
check("dork weighs 0.5 per copy", () => {
  const { byColor } = nonlandSourceCredit([ELVES], { "Llanowar Elves": 4 });
  assert.deepStrictEqual(byColor, { W: 0, U: 0, B: 0, R: 0, G: 2 });
});

check("rock weighs 0.75 per copy, credited to EVERY produced color", () => {
  const { byColor } = nonlandSourceCredit([SIGNET], { "Azorius Signet": 2 });
  assert.strictEqual(byColor.W, 1.5);
  assert.strictEqual(byColor.U, 1.5);
  assert.strictEqual(byColor.B, 0);
});

check("credits stack across producers sharing a color", () => {
  const { byColor } = nonlandSourceCredit([ELVES, LOCKET], {
    "Llanowar Elves": 2,
    "Golgari Locket": 2,
  });
  assert.strictEqual(byColor.G, 2 * 0.5 + 2 * 0.75); // 2.5
  assert.strictEqual(byColor.B, 1.5);
});

check("producers list carries name/qty/colors/kind/mv/weight (mv falls back to cost)", () => {
  const { producers } = nonlandSourceCredit([ELVES, LOCKET], {
    "Llanowar Elves": 4,
    "Golgari Locket": 1,
  });
  assert.strictEqual(producers.length, 2);
  const elves = producers.find((p) => p.name === "Llanowar Elves");
  assert.deepStrictEqual(elves, { name: "Llanowar Elves", qty: 4, colors: ["G"], kind: "dork", mv: 1, weight: 0.5 });
  const locket = producers.find((p) => p.name === "Golgari Locket");
  assert.strictEqual(locket.mv, 3); // manaValue("{3}")
  assert.strictEqual(locket.weight, 0.75);
});

check("non-producers, unknown kinds, empty manaColors, and zero-qty cards contribute nothing", () => {
  const weird = { name: "Weird", manaColors: ["R"], manaKind: "ritual", mv: 1 }; // one-shot, not credited
  const colorless = { name: "Gray Rock", manaColors: [], manaKind: "rock", mv: 2 };
  const r = nonlandSourceCredit([BEAR, weird, colorless, ELVES], { "Grizzly Bears": 4, Weird: 4, "Gray Rock": 4 });
  // ELVES absent from qtyByName -> 0 copies
  assert.deepStrictEqual(r.byColor, { W: 0, U: 0, B: 0, R: 0, G: 0 });
  assert.strictEqual(r.producers.length, 0);
});

check("qtyByName omitted -> every card counts once", () => {
  const { byColor } = nonlandSourceCredit([ELVES, SIGNET]);
  assert.strictEqual(byColor.G, 0.5);
  assert.strictEqual(byColor.W, 0.75);
});

// --- creditForSpell: the producer must land a turn earlier ------------------
check("a 1-mv dork credits turn-2+ spells but not turn-1 spells", () => {
  const credit = nonlandSourceCredit([ELVES], { "Llanowar Elves": 4 });
  assert.strictEqual(creditForSpell(credit, 1).G, 0);
  assert.strictEqual(creditForSpell(credit, 2).G, 2);
  assert.strictEqual(creditForSpell(credit, 5).G, 2);
});

check("a 3-mv rock credits turn-4+ spells only", () => {
  const credit = nonlandSourceCredit([LOCKET], { "Golgari Locket": 2 });
  assert.strictEqual(creditForSpell(credit, 3).B, 0);
  assert.strictEqual(creditForSpell(credit, 4).B, 1.5);
  assert.strictEqual(creditForSpell(credit, 4).G, 1.5);
});

check("creditForSpell mixes producers by their own mv gates", () => {
  const credit = nonlandSourceCredit([ELVES, LOCKET], { "Llanowar Elves": 4, "Golgari Locket": 2 });
  const t3 = creditForSpell(credit, 3);
  assert.strictEqual(t3.G, 2);        // elves yes (1 < 3), locket no (3 !< 3)
  const t4 = creditForSpell(credit, 4);
  assert.strictEqual(t4.G, 3.5);      // both
});

// --- creditAdjustedRequirements: ceil of the fractional remainder, floor 0 --
check("half a source does not shave a land; a full source does", () => {
  assert.deepStrictEqual(
    creditAdjustedRequirements({ W: 13 }, { W: 0.5 }),
    { W: 13, U: 0, B: 0, R: 0, G: 0 }, // ceil(12.5) = 13
  );
  assert.deepStrictEqual(
    creditAdjustedRequirements({ W: 13 }, { W: 1 }),
    { W: 12, U: 0, B: 0, R: 0, G: 0 },
  );
  assert.strictEqual(creditAdjustedRequirements({ G: 14 }, { G: 2.5 }).G, 12); // ceil(11.5)
});

check("credit beyond the need floors at 0; missing credit leaves colors untouched", () => {
  const out = creditAdjustedRequirements({ W: 3, U: 14 }, { W: 7.25 });
  assert.strictEqual(out.W, 0);
  assert.strictEqual(out.U, 14);
});

// --- recommend() threads the credit into the greedy fallback ----------------
const PLAINS = { name: "Plains", colors: ["W"], basic: true, tapped: false };
const FOREST = { name: "Forest", colors: ["G"], basic: true, tapped: false };

check("recommend with credit needs fewer lands; without credit it is unchanged", () => {
  const req = { W: 4 };
  const plain = recommend(req, [PLAINS]);
  assert.strictEqual(plain.total, 4);
  const credited = recommend(req, [PLAINS], { credit: { W: 2 } });
  assert.strictEqual(credited.total, 2);
  assert.strictEqual(credited.met.W, true);
  // fractional remainder rounds UP: 4 - 1.5 = 2.5 -> 3 lands
  const frac = recommend(req, [PLAINS], { credit: { W: 1.5 } });
  assert.strictEqual(frac.total, 3);
});

check("credit >= requirement -> zero lands of that color needed", () => {
  const r = recommend({ W: 3, G: 2 }, [PLAINS, FOREST], { credit: { W: 5 } });
  assert.strictEqual(r.counts.Plains ?? 0, 0);
  assert.strictEqual(r.counts.Forest, 2);
  assert.strictEqual(r.met.W, true); // 0 sources >= adjusted 0
});

check("phase-2 top-up honors the credit-adjusted surplus", () => {
  // W needs 4 but has 2 credit (adjusted 2), G needs 2. Target 8 lands: after
  // phase 1 (2 Plains + 2 Forest), top-ups go to the color furthest below its
  // ADJUSTED requirement surplus, keeping the split balanced around it.
  const r = recommend({ W: 4, G: 2 }, [PLAINS, FOREST], { credit: { W: 2 }, landTarget: 8 });
  assert.strictEqual(r.total, 8);
  // surpluses stay within 1 of each other relative to adjusted needs (2 and 2)
  const surplusW = r.sources.W - 2, surplusG = r.sources.G - 2;
  assert.ok(Math.abs(surplusW - surplusG) <= 1, `balanced top-up: W+${surplusW} G+${surplusG}`);
});

console.log(`\nAll ${passed} credit checks passed.`);
