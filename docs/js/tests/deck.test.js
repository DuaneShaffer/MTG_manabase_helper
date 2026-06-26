// Node test (ES module) for decklist.js and recommend.js.
// Run: node docs/js/tests/deck.test.js  -- must exit 0.

import assert from "node:assert";
import { parseDeckText, deckEntries, cardNames } from "../decklist.js";
import { recommend, recommendLandCount } from "../recommend.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

// --- decklist ---

test("parse full decklist with sections", () => {
  const text =
    "Deck\n4 Adarkar Wastes (DMU) 243\n2 Teferi, Who Slows the Sunset (MID) 245\n\nSideboard\n1 Negate (RIX) 44";
  const entries = parseDeckText(text);

  const teferi = entries.find((e) => e.name === "Teferi, Who Slows the Sunset");
  assert.ok(teferi, "Teferi entry exists");
  assert.strictEqual(teferi.qty, 2);
  assert.strictEqual(teferi.set, "MID");
  assert.strictEqual(teferi.collector, "245");
  assert.strictEqual(teferi.section, "deck");

  const deck = deckEntries(entries, "deck");
  assert.strictEqual(deck.length, 2, "deck section has 2 cards");

  const side = deckEntries(entries, "sideboard");
  assert.strictEqual(side.length, 1);
  assert.strictEqual(side[0].name, "Negate");

  const names = cardNames(entries);
  assert.deepStrictEqual(names, [
    "Adarkar Wastes",
    "Teferi, Who Slows the Sunset",
    "Negate",
  ]);
});

test("parse bare qty name line, headers and blanks skipped", () => {
  const entries = parseDeckText("Deck\n\n3 Llanowar Elves\n");
  assert.strictEqual(entries.length, 1);
  const e = entries[0];
  assert.strictEqual(e.qty, 3);
  assert.strictEqual(e.name, "Llanowar Elves");
  assert.strictEqual(e.set, null);
  assert.strictEqual(e.collector, null);
});

// --- recommend ---

const plains = { name: "Plains", colors: ["W"], basic: true, tapped: false };
const island = { name: "Island", colors: ["U"], basic: true, tapped: false };

test("meets requirements with basics only", () => {
  const r = recommend({ W: 10, U: 6 }, [plains, island]);
  assert.strictEqual(r.met.W, true);
  assert.strictEqual(r.met.U, true);
  assert.deepStrictEqual(r.shortfall, {});
  assert.strictEqual(r.sources.W >= 10, true);
  assert.strictEqual(r.sources.U >= 6, true);
});

test("prefers a dual over basics", () => {
  const wu = { name: "WU", colors: ["W", "U"], basic: false, tapped: false };
  const r = recommend({ W: 4, U: 4 }, [plains, island, wu]);
  assert.strictEqual(r.counts["WU"], 4);
  assert.strictEqual(r.total, 4);
});

test("prefers untapped dual over tapped dual", () => {
  const wuTapped = { name: "WU-tapped", colors: ["W", "U"], basic: false, tapped: true };
  const wuUntapped = { name: "WU-untapped", colors: ["W", "U"], basic: false, tapped: false };
  const r = recommend({ W: 4, U: 4 }, [wuTapped, wuUntapped]);
  assert.strictEqual(r.counts["WU-untapped"], 4);
  assert.strictEqual(r.counts["WU-tapped"], undefined);
});

test("prefers a focused dual over a rainbow land", () => {
  // A 2-color (W/U) deck should build with the WU dual, not a 5-color land
  // that wastes three off-colors — even though both "cover" W and U.
  const wu = { name: "WU dual", colors: ["W", "U"], basic: false, tapped: false };
  const rainbow = { name: "Rainbow", colors: ["W", "U", "B", "R", "G"], basic: false, tapped: false };
  const r = recommend({ W: 4, U: 4 }, [rainbow, wu]);
  assert.strictEqual(r.counts["WU dual"], 4);
  assert.strictEqual(r.counts["Rainbow"], undefined);
});

test("recommendation is deterministic regardless of pool order", () => {
  const a = { name: "Aaa dual", colors: ["W", "U"], basic: false, tapped: false };
  const z = { name: "Zzz dual", colors: ["W", "U"], basic: false, tapped: false };
  const r1 = recommend({ W: 4, U: 4 }, [a, z]);
  const r2 = recommend({ W: 4, U: 4 }, [z, a]);
  assert.deepStrictEqual(r1.counts, r2.counts);
  assert.strictEqual(r1.counts["Aaa dual"], 4); // name-sorted tiebreak
});

test("landTarget tops up with basics past the needed count", () => {
  const r = recommend({ W: 4 }, [plains], { landTarget: 10 });
  assert.strictEqual(r.total, 10);
  assert.strictEqual(r.met.W, true);
});

test("recommendLandCount(3.0, 60) is in a sane range", () => {
  const n = recommendLandCount(3.0, 60);
  assert.ok(n >= 22 && n <= 27, `expected 22..27, got ${n}`);
});

console.log(`\n${passed} tests passed`);
