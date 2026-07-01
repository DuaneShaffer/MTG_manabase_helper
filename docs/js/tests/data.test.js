// Tests for the data layer (data.js): resolveDeck's input-name -> canonical-card
// mapping, the load-failure behavior, and the Scryfall batch courtesy delay.
// data.js reaches the network only through global fetch, so we stub it — the
// module itself is imported unmodified.
import assert from "assert";

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("ok - " + name); passed++; };

// Committed-index stub: keys are LOWERCASE names, values carry the canonical name
// (same shape as docs/data/cards.json).
const INDEX = {
  "lightning strike": { name: "Lightning Strike", cost: "{1}{R}", type: "Instant" },
  "hearth elemental // stoke genius": {
    name: "Hearth Elemental // Stoke Genius", cost: "{5}{R}",
    type: "Creature — Elemental // Sorcery — Adventure",
  },
  "invert // invent": { name: "Invert // Invent", cost: "{U/R}", type: "Instant // Instant" },
};

let cardsResponses = [];   // queued overrides for the cards.json fetch (default: success)
const scryPosts = [];      // one record per Scryfall collection POST {t, n}
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("cards.json")) {
    return cardsResponses.shift() || { ok: true, json: async () => INDEX };
  }
  if (u.includes("scryfall")) {
    scryPosts.push({ t: Date.now(), n: JSON.parse(opts.body).identifiers.length });
    return { ok: false, status: 404 };
  }
  throw new Error("unexpected fetch: " + u);
};

const { resolveDeck } = await import("../data.js");

// 1. A failed cards.json load throws a useful error and is NOT cached — the next
// call refetches and succeeds. (Must run first: success permanently caches.)
{
  cardsResponses = [{ ok: false, status: 503 }];
  let err = null;
  try { await resolveDeck(["Lightning Strike"]); } catch (e) { err = e; }
  ok("load failure names the file and status", !!err && /cards\.json/.test(err.message) && /503/.test(err.message));
  const { entries } = await resolveDeck(["Lightning Strike"]);
  ok("a rejected load is not cached (retry succeeds)", entries.length === 1);
}

// 2. Each resolved entry maps the INPUT name to the canonical card.
{
  const { entries, missing } = await resolveDeck([
    "LIGHTNING strike",        // case-differing input still resolves...
    "Hearth Elemental",        // ...front-face name of a DFC/adventure
    "Invert / Invent",         // ...single-space split-card slash
  ]);
  ok("no names went missing", missing.length === 0);
  const byInput = Object.fromEntries(entries.map((e) => [e.inputName, e.card.name]));
  ok("case-differing input keeps its input name",
    byInput["LIGHTNING strike"] === "Lightning Strike");
  ok("front-face input resolves to the full canonical name",
    byInput["Hearth Elemental"] === "Hearth Elemental // Stoke Genius");
  ok("' / ' split input normalizes to the ' // ' canonical name",
    byInput["Invert / Invent"] === "Invert // Invent");
}

// 3. Names absent from the index (and from the Scryfall fallback) come back in
// `missing` verbatim.
{
  const { entries, missing } = await resolveDeck(["Lightning Strike", "Not A Real Card"]);
  ok("unresolvable name is reported missing", missing.length === 1 && missing[0] === "Not A Real Card");
  ok("resolvable names still resolve alongside a miss", entries.length === 1);
}

// 4. Scryfall fallback batches of 75 get a courtesy pause between them.
{
  scryPosts.length = 0;
  const names = Array.from({ length: 80 }, (_, i) => `Fake Card ${i}`);
  await resolveDeck(names);
  ok("fallback splits into 75-card batches", scryPosts.length === 2 && scryPosts[0].n === 75 && scryPosts[1].n === 5);
  ok("consecutive batches are ~100ms apart", scryPosts[1].t - scryPosts[0].t >= 90);
}

console.log(`\n${passed} data tests passed`);
