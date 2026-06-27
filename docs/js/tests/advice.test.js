// Tests for manabaseAdvice (advice.js). Pure over recommender options + context,
// so no solver is needed — we hand-build option shapes for each situation.
import assert from "assert";
import { manabaseAdvice } from "../advice.js";

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("ok - " + name); passed++; };
const opt = (rec) => ({ label: "x", rec: { sources: {}, shortfall: {}, taplands: 0, ...rec } });

// 1. Everything covered at the target, no slack.
{
  const a = manabaseAdvice([opt({ sources: { U: 14, B: 14 }, total: 24 })],
    { requirements: { U: 14, B: 14 }, landTarget: 24, demand: { U: 20, B: 20 } });
  ok("covered: status is 'covered'", a.status === "covered");
  ok("covered: no levers to push", a.levers.length === 0);
}

// 2. Covered with a leaner option available -> slack advice.
{
  const a = manabaseAdvice([
    opt({ sources: { U: 16, B: 16 }, total: 24 }),
    opt({ sources: { U: 14, B: 14 }, total: 21 }),
  ], { requirements: { U: 14, B: 14 }, landTarget: 24, demand: { U: 20, B: 20 } });
  ok("slack: status is 'covered-slack'", a.status === "covered-slack");
  ok("slack: names the leaner count", a.detail.join(" ").includes("21"));
}

// 3. Single color short because its requirement exceeds the land count (structural).
{
  const a = manabaseAdvice([opt({ sources: { U: 20, R: 18 }, total: 20, shortfall: { U: 1 } })], {
    requirements: { U: 21, R: 16 }, landTarget: 20,
    demand: { U: 36, R: 10 }, // U is the HEAVIEST color, yet it's the one short
    colorInfo: { U: { cards: 31, driver: { name: "Eddymurk Crab", pips: 2, qty: 4 } }, R: { cards: 10, driver: null } },
  });
  ok("structural: status is 'short-one'", a.status === "short-one");
  ok("structural: explains land-count ceiling, not 'least-leaned-on'",
    a.detail.join(" ").includes("at most 20") && !a.detail.join(" ").includes("leans on least"));
  ok("structural: offers add-lands and cut-card levers", a.levers.length >= 2 && a.levers.some((l) => l.includes("Eddymurk Crab")));
}

// 4. Single secondary color short by losing the cap competition (demand-driven).
{
  const a = manabaseAdvice([opt({ sources: { G: 18, W: 12 }, total: 18, shortfall: { W: 2 } })], {
    requirements: { W: 14, G: 14 }, landTarget: 18, // both reqs <= target, so not structural
    demand: { W: 9, G: 30 }, // W is the lightest -> the one we give on
    colorInfo: { W: { cards: 6, driver: { name: "Splash Card", pips: 1, qty: 3 } }, G: { cards: 20, driver: null } },
  });
  ok("demand-driven: explains it as the least-leaned-on color", a.detail.join(" ").includes("leans on least"));
}

// 5. Several colors short -> 'short-many'.
{
  const a = manabaseAdvice([opt({ sources: { W: 12, U: 13, R: 12 }, total: 24, shortfall: { W: 4, U: 1, R: 4 } })], {
    requirements: { W: 16, U: 14, R: 16 }, landTarget: 24, demand: { W: 13, U: 15, R: 20 } });
  ok("multi: status is 'short-many'", a.status === "short-many");
  ok("multi: suggests committing to fewer colors", a.levers.join(" ").toLowerCase().includes("two main colors"));
}

console.log(`\n${passed} advice tests passed`);
