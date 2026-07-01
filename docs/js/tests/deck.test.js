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

test("4x / x4 quantity tokens parse as quantities, not section headers", () => {
  const entries = parseDeckText("4x Lightning Bolt\nX2 Shock\n1 Mountain (DMU) 269\n3X Frostbite");
  assert.strictEqual(entries.length, 4);
  assert.deepStrictEqual(
    entries.map((e) => [e.qty, e.name]),
    [[4, "Lightning Bolt"], [2, "Shock"], [1, "Mountain"], [3, "Frostbite"]],
  );
  // Crucially, none of them got mistaken for a header: everything stays "deck".
  assert.ok(entries.every((e) => e.section === "deck"));
  // And the 4x style still supports the (SET) COLLECTOR suffix.
  const [bolt] = parseDeckText("4x Lightning Bolt (STA) 42");
  assert.strictEqual(bolt.qty, 4);
  assert.strictEqual(bolt.name, "Lightning Bolt");
  assert.strictEqual(bolt.set, "STA");
  assert.strictEqual(bolt.collector, "42");
});

test("names containing parentheses still parse", () => {
  // A parenthesized word inside the name must not be mistaken for the set code.
  const [a] = parseDeckText("4 Hazmat Suit (Used)");
  assert.strictEqual(a.name, "Hazmat Suit (Used)");
  assert.strictEqual(a.set, null);
  const [b] = parseDeckText("4 Hazmat Suit (Used) (UST) 33");
  assert.strictEqual(b.name, "Hazmat Suit (Used)");
  assert.strictEqual(b.set, "UST");
  assert.strictEqual(b.collector, "33");
});

// --- blank-line sideboard heuristic (headerless exports) ---

test("(a) explicit headers: blank lines never switch sections", () => {
  // Blank between the Deck header and its cards, blanks inside a headered
  // section, and a blank before the Sideboard header — none may re-section.
  const text = "Deck\n\n4 Plains\n\n\n4 Island\n\nSideboard\n\n2 Negate";
  const entries = parseDeckText(text);
  assert.deepStrictEqual(
    entries.map((e) => [e.name, e.section]),
    [["Plains", "deck"], ["Island", "deck"], ["Negate", "sideboard"]],
  );
});

test("(b) no headers, no blanks: everything is maindeck", () => {
  const entries = parseDeckText("4 Plains\n4 Island\n2 Negate");
  assert.ok(entries.every((e) => e.section === "deck"));
  assert.strictEqual(deckEntries(entries).length, 3);
});

test("(c) no headers, one blank block: cards after it are the sideboard", () => {
  const entries = parseDeckText("4 Plains\n4 Island\n\n2 Negate\n1 Duress");
  assert.deepStrictEqual(
    entries.map((e) => [e.name, e.section]),
    [["Plains", "deck"], ["Island", "deck"], ["Negate", "sideboard"], ["Duress", "sideboard"]],
  );
  // A RUN of blank lines is one separator, and later blanks don't invent
  // further sections — everything after the first break stays sideboard.
  const runs = parseDeckText("4 Plains\n\n\n\n2 Negate\n\n1 Duress");
  assert.deepStrictEqual(
    runs.map((e) => [e.name, e.section]),
    [["Plains", "deck"], ["Negate", "sideboard"], ["Duress", "sideboard"]],
  );
});

test("(d) leading blank lines don't trigger the sideboard switch", () => {
  const entries = parseDeckText("\n\n4 Plains\n4 Island");
  assert.ok(entries.every((e) => e.section === "deck"));
  // ...but a later blank block still separates the sideboard as usual.
  const mixed = parseDeckText("\n4 Plains\n\n2 Negate");
  assert.deepStrictEqual(
    mixed.map((e) => [e.name, e.section]),
    [["Plains", "deck"], ["Negate", "sideboard"]],
  );
});

test("headerless heuristic works with 4x-style quantities too", () => {
  // The 4x fix and the blank-line heuristic have to compose: a 4x line is a
  // CARD (not a header), so the list counts as headerless and the blank
  // separates the sideboard.
  const entries = parseDeckText("4x Lightning Bolt\n\n2x Duress");
  assert.deepStrictEqual(
    entries.map((e) => [e.name, e.section]),
    [["Lightning Bolt", "deck"], ["Duress", "sideboard"]],
  );
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

test("recommendLandCount caps the draw/ramp discount at 3 lands", () => {
  const base = recommendLandCount(2.0, 60, 0);
  const manyCantrips = recommendLandCount(2.0, 60, 20); // 20 cheap cantrips
  assert.strictEqual(base - manyCantrips, 3, `expected a 3-land cap, got ${base - manyCantrips}`);
});

test("recommendLandCount(3.0, 60) is in a sane range", () => {
  const n = recommendLandCount(3.0, 60);
  assert.ok(n >= 22 && n <= 27, `expected 22..27, got ${n}`);
});

console.log(`\n${passed} tests passed`);
