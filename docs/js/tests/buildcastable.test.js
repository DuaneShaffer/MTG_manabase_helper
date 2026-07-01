// Validates buildCastable — the exact gold-card castability model computed from
// the ACTUAL land build — against an independent brute-force Monte-Carlo
// reference, plus structural invariants. Run with:
//   node docs/js/tests/buildcastable.test.js
import assert from "node:assert";

import {
  buildCastable,
  multivariateCastable,
  castableProbability,
  cardsSeen,
} from "../hypergeometric.js";

let passed = 0;
function check(desc, fn) {
  fn();
  passed += 1;
  console.log("ok - " + desc);
}

// --- independent reference model (plain Monte Carlo + bipartite matching) ---
// Deliberately a DIFFERENT algorithm from the implementation: it samples real
// draws and decides payability by augmenting-path matching (each pip claims a
// distinct land), rather than category enumeration + Hall's condition.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Can every need (array of acceptable colors) claim a distinct land?
function matchable(needs, lands) {
  const owner = new Array(lands.length).fill(-1);
  const tryPlace = (n, seen) => {
    for (let l = 0; l < lands.length; l++) {
      if (seen[l] || !lands[l].some((c) => needs[n].includes(c))) continue;
      seen[l] = true;
      if (owner[l] === -1 || tryPlace(owner[l], seen)) { owner[l] = n; return true; }
    }
    return false;
  };
  for (let n = 0; n < needs.length; n++) {
    if (!tryPlace(n, new Array(lands.length).fill(false))) return false;
  }
  return true;
}

// P(pips payable AND >= mv lands | >= mv lands among `seen` cards), sampled.
function sampleCastable(pipsByColor, mv, hybrids, landGroups, deckSize, trials, seed) {
  const deck = [];
  for (const g of landGroups) for (let i = 0; i < g.count; i++) deck.push(g.colors);
  while (deck.length < deckSize) deck.push(null);
  const needs = [];
  for (const c in pipsByColor) for (let i = 0; i < pipsByColor[c]; i++) needs.push([c]);
  for (const pair of hybrids || []) needs.push(pair);
  const seen = cardsSeen(Math.max(mv, needs.length), true);
  const rng = mulberry32(seed);
  let conditioned = 0, ok = 0;
  for (let t = 0; t < trials; t++) {
    // partial Fisher–Yates: only the first `seen` cards matter
    for (let i = 0; i < seen; i++) {
      const j = i + Math.floor(rng() * (deck.length - i));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    const lands = [];
    for (let i = 0; i < seen; i++) if (deck[i] !== null) lands.push(deck[i]);
    if (lands.length < mv) continue;   // condition on hitting land drops
    conditioned++;
    if (matchable(needs, lands)) ok++;
  }
  assert.ok(conditioned > trials / 4, `conditioning rejected too much (${conditioned}/${trials})`);
  return ok / conditioned;
}

const TRIALS = 200000;
const TOL = 0.005;

function compare(desc, pips, mv, hybrids, groups, deckSize = 60, seed = 12345) {
  check(desc, () => {
    const exact = buildCastable(pips, mv, hybrids, groups, deckSize, true);
    const sampled = sampleCastable(pips, mv, hybrids, groups, deckSize, TRIALS, seed);
    assert.ok(Math.abs(exact - sampled) < TOL,
      `exact ${exact.toFixed(5)} vs sampled ${sampled.toFixed(5)} (diff ${(exact - sampled).toFixed(5)})`);
  });
}

// --- reference-model comparisons -------------------------------------------
compare("dual-heavy: WWUU mv4 vs 24 WU duals matches brute force",
  { W: 2, U: 2 }, 4, [], [{ count: 24, colors: ["W", "U"] }]);

compare("mixed base: WWUU mv4 vs 8W + 8U + 8WU matches brute force",
  { W: 2, U: 2 }, 4, [],
  [{ count: 8, colors: ["W"] }, { count: 8, colors: ["U"] }, { count: 8, colors: ["W", "U"] }],
  60, 22222);

compare("mixed base: {W}{U} mv2 vs 8W + 8U + 8WU matches brute force",
  { W: 1, U: 1 }, 2, [],
  [{ count: 8, colors: ["W"] }, { count: 8, colors: ["U"] }, { count: 8, colors: ["W", "U"] }],
  60, 33333);

const THREE_COLOR = [
  { count: 4, colors: ["W"] }, { count: 4, colors: ["U"] }, { count: 4, colors: ["B"] },
  { count: 4, colors: ["W", "U"] }, { count: 4, colors: ["U", "B"] }, { count: 4, colors: ["W", "B"] },
];
compare("3-color: {W}{U}{B} mv3 vs 12 monos + 12 duals matches brute force",
  { W: 1, U: 1, B: 1 }, 3, [], THREE_COLOR, 60, 44444);

compare("hybrid: {1}{W}{U/B} mv3 (Hall handles either-color pips) matches brute force",
  { W: 1 }, 3, [["U", "B"]], THREE_COLOR, 60, 55555);

// --- invariants --------------------------------------------------------------
check("single-color card matches the univariate castableProbability exactly", () => {
  const groups = [{ count: 14, colors: ["W"] }, { count: 10, colors: ["U"] }];
  const got = buildCastable({ W: 2 }, 3, [], groups, 60, true);
  const want = castableProbability(2, 3, 14, 60, 24, true);
  assert.ok(Math.abs(got - want) < 1e-12, `got ${got}, want ${want}`);
});

check("a lone hybrid pip equals univariate over the union of its colors", () => {
  // {1}{W/U}: one pip payable by W or U == one pip with sources = all W∪U lands.
  const groups = [
    { count: 9, colors: ["W"] }, { count: 5, colors: ["U"] },
    { count: 4, colors: ["W", "U"] }, { count: 6, colors: ["G"] },
  ];
  const got = buildCastable({}, 2, [["W", "U"]], groups, 60, true);
  const want = castableProbability(1, 2, 18, 60, 24, true);  // 9+5+4 W∪U sources of 24 lands
  assert.ok(Math.abs(got - want) < 1e-12, `got ${got}, want ${want}`);
});

check("exact model beats the disjoint floor-scaling on a dual-heavy base", () => {
  const exact = buildCastable({ W: 2, U: 2 }, 4, [], [{ count: 24, colors: ["W", "U"] }], 60, true);
  // Old model: the 24 duals tally as 24 W + 24 U, floor-scaled into 12/12 disjoint.
  const old = multivariateCastable({ W: 2, U: 2 }, 4, { W: 24, U: 24 }, 60, 24, true);
  assert.ok(exact > old, `expected exact (${exact.toFixed(4)}) > disjoint (${old.toFixed(4)})`);
  // Sanity: with every land a dual, colors can't fail once you have 4+ lands — ~1.0.
  assert.ok(exact > 0.999, `all-duals base should be ~certain given lands, got ${exact}`);
});

check("exact >= disjoint approximation on a mixed base too", () => {
  const groups = [{ count: 8, colors: ["W"] }, { count: 8, colors: ["U"] }, { count: 8, colors: ["W", "U"] }];
  const exact = buildCastable({ W: 2, U: 2 }, 4, [], groups, 60, true);
  const old = multivariateCastable({ W: 2, U: 2 }, 4, { W: 16, U: 16 }, 60, 24, true);
  assert.ok(exact >= old - 1e-12, `exact ${exact} < old ${old}`);
});

check("adding a dual land never decreases the probability", () => {
  let prev = 0;
  for (let n = 0; n <= 8; n++) {
    const groups = [{ count: 8, colors: ["W"] }, { count: 8, colors: ["U"] }];
    if (n) groups.push({ count: n, colors: ["W", "U"] });
    const p = buildCastable({ W: 2, U: 2 }, 4, [], groups, 60, true);
    assert.ok(p >= prev - 1e-12, `p dropped from ${prev} to ${p} at ${n} duals`);
    prev = p;
  }
});

check("swapping an off-color land for a dual never decreases the probability", () => {
  for (let n = 0; n <= 8; n++) {
    const base = [
      { count: 8, colors: ["W"] }, { count: 8, colors: ["U"] },
      { count: n, colors: ["W", "U"] }, { count: 8 - n, colors: ["G"] },
    ].filter((g) => g.count > 0);
    const more = [
      { count: 8, colors: ["W"] }, { count: 8, colors: ["U"] },
      { count: n + 1, colors: ["W", "U"] }, { count: 7 - n, colors: ["G"] },
    ].filter((g) => g.count > 0);
    const p0 = buildCastable({ W: 2, U: 2 }, 4, [], base, 60, true);
    const p1 = buildCastable({ W: 2, U: 2 }, 4, [], more, 60, true);
    assert.ok(p1 >= p0 - 1e-12, `swap to dual dropped ${p0} -> ${p1} at n=${n}`);
  }
});

check("zero relevant sources gives 0", () => {
  assert.strictEqual(buildCastable({ W: 2, U: 2 }, 4, [], [{ count: 24, colors: ["G"] }], 60, true), 0);
  assert.strictEqual(buildCastable({ W: 1, U: 1 }, 2, [], [], 60, true), 0);  // no lands at all
});

check("no pips at all gives 1", () => {
  assert.strictEqual(buildCastable({}, 3, [], [{ count: 24, colors: ["G"] }], 60, true), 1.0);
});

// --- performance guard -------------------------------------------------------
// Grading runs per spell per build edit; every edit changes the land counts, so
// each call below uses a FRESH cache key (the worst case). Budget: ~1ms/call.
check("fresh-key gold grades stay near a millisecond", () => {
  const t0 = process.hrtime.bigint();
  let calls = 0;
  for (let w = 4; w <= 12; w += 2) {
    for (let u = 4; u <= 12; u += 2) {
      for (let d = 0; d <= 12; d += 3) {
        // 2-color gold card against a w/u/d build (+ a splash + off-color utility)
        buildCastable({ W: 2, U: 2 }, 4, [],
          [{ count: w, colors: ["W"] }, { count: u, colors: ["U"] },
           { count: d, colors: ["W", "U"] }, { count: 2, colors: ["U", "B"] },
           { count: 1, colors: [] }], 60, true);
        // 3-color card against a 6-category build
        buildCastable({ W: 1, U: 1, B: 1 }, 3, [],
          [{ count: w, colors: ["W"] }, { count: 4, colors: ["U"] }, { count: 4, colors: ["B"] },
           { count: d, colors: ["W", "U"] }, { count: u % 5, colors: ["U", "B"] },
           { count: 3, colors: ["W", "B"] }], 60, true);
        calls += 2;
      }
    }
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const per = ms / calls;
  console.log(`   ${calls} fresh-key calls in ${ms.toFixed(1)}ms — ${per.toFixed(3)}ms/call`);
  assert.ok(per < 5, `expected ~1ms per fresh gold grade, got ${per.toFixed(2)}ms`);
});

console.log(`\nAll ${passed} checks passed.`);
