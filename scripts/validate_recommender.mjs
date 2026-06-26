// Validate the land RECOMMENDERS against real metagame decks.
//
// Compares every recommender heuristic the app ships — the greedy recommend()
// and the ILP optimizer's objectives (most-untapped / fewest-tapped / fewest-
// total) — to the pros' actual nonbasic lands. For each method it reports:
//   - nonbasic Jaccard vs the pro list (overlap of fixing choices), and
//   - how many brand-new-set lands it reaches for.
//
// Release dates come from tests/fixtures/land_sets.json (a committed Scryfall
// snapshot). Regenerate that cache if the land pool changes substantially.
//
// Run:  node scripts/validate_recommender.mjs
//
// Offline; dev/analysis tool, not part of the app or CI. Pro lists are a sanity
// signal, not ground truth — many valid manabases exist, so don't expect 1.0.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const JS = path.join(ROOT, "docs/js");
const DATA = path.join(ROOT, "docs/data");

// Load the vendored browser solver into globalThis.solver so optimize.js's
// loadSolver() finds it without a DOM (same shim the optimizer's tests use).
const bundle = fs.readFileSync(path.join(JS, "vendor/lp-solver.js"), "utf8")
  .replace(/^\/\* jsLPSolver[\s\S]*?\*\/\n/, "");
globalThis.window = globalThis;
(0, eval)(bundle);

const { parseDeckText, deckEntries, cardNames } = await import(path.join(JS, "decklist.js"));
const { requirementsForCards } = await import(path.join(JS, "requirements.js"));
const { recommend, recommendLandCount } = await import(path.join(JS, "recommend.js"));
const { optimizeManabase, OBJECTIVES } = await import(path.join(JS, "optimize.js"));
const { manaValue } = await import(path.join(JS, "mana.js"));

const cards = JSON.parse(fs.readFileSync(path.join(DATA, "cards.json"), "utf8"));
const landsArr = JSON.parse(fs.readFileSync(path.join(DATA, "lands.json"), "utf8"));
const landByName = new Map(landsArr.map((l) => [l.name.toLowerCase(), l]));
const DECKS = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/meta_decks.json"), "utf8"));
const landSets = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/land_sets.json"), "utf8"));

const NEW_WAVE = new Date("2026-06-26");
const SMOOTH_MAX_MV = 2;
const isLandType = (type) => (type || "").split("—")[0].includes("Land");
const isNewWave = (name) => {
  const rel = landSets[name]?.released_at;
  return rel ? new Date(rel) >= NEW_WAVE : false;
};

function resolve(name) {
  const k = name.toLowerCase();
  if (cards[k]) return cards[k];
  const front = k.split(" / ")[0];
  if (cards[front]) return cards[front];
  for (const key of Object.keys(cards)) if (key.startsWith(front + " //")) return cards[key];
  return null;
}
const nonbasics = (counts) => Object.keys(counts).filter((n) => !(landByName.get(n.toLowerCase())?.basic));
const jaccard = (a, b) => {
  const A = new Set(a), B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  const uni = new Set([...A, ...B]).size;
  return uni ? inter / uni : 1;
};

// methods: key -> async (requirements, landTarget) => {counts}
const METHODS = [
  ["greedy", async (req, t) => recommend(req, landsArr, { landTarget: t })],
  ...Object.keys(OBJECTIVES).map((obj) => [
    "ilp:" + obj,
    async (req, t) => optimizeManabase({ requirements: req, lands: landsArr, landTarget: t, objective: obj }),
  ]),
];

const agg = {}; // method -> { jac: [], newWave: 0 }
for (const [k] of METHODS) agg[k] = { jac: [], newWave: 0 };

for (const deck of DECKS) {
  const entries = deckEntries(parseDeckText(deck.list), "deck");
  const qtyByName = {}; let deckSize = 0;
  for (const e of entries) { qtyByName[e.name] = (qtyByName[e.name] || 0) + e.qty; deckSize += e.qty; }
  const resolved = cardNames(entries).map(resolve).filter(Boolean);
  const requirements = requirementsForCards(resolved.map((c) => ({ cost: c.cost })), deckSize, null);
  const deckCards = resolved.filter((c) => !isLandType(c.type));
  const avgMV = deckCards.length ? deckCards.reduce((s, c) => s + manaValue(c.cost), 0) / deckCards.length : 3;
  const smoothCount = resolved.filter((c) => c.smooth && !isLandType(c.type) && manaValue(c.cost) <= SMOOTH_MAX_MV)
    .reduce((s, c) => s + (qtyByName[c.name] || 0), 0);
  const landTarget = recommendLandCount(avgMV, deckSize, smoothCount);

  const proNB = [];
  for (const e of entries) {
    const ld = landByName.get(e.name.toLowerCase());
    if (ld && !ld.basic) proNB.push(e.name);
  }

  console.log("=".repeat(72));
  console.log(`${deck.archetype}   (target ~${landTarget} lands)`);
  console.log(`  PRO nonbasics: ${proNB.map((n) => `${n}×${qtyByName[n]}`).join(", ")}`);
  for (const [k, run] of METHODS) {
    let res;
    try { res = await run(requirements, landTarget); }
    catch (e) { console.log(`  ${k.padEnd(14)} ERROR: ${e.message}`); continue; }
    const nb = nonbasics(res.counts);
    const newPicked = nb.filter(isNewWave);
    const j = jaccard(nb, proNB);
    agg[k].jac.push(j); agg[k].newWave += newPicked.length;
    console.log(`  ${k.padEnd(14)} J=${j.toFixed(2)}  total=${res.total ?? "?"} tapped=${res.taplands ?? "?"}` +
      `${newPicked.length ? `  new-wave: ${newPicked.join(", ")}` : ""}`);
    console.log(`  ${" ".repeat(14)} picks: ${nb.map((n) => `${n}×${res.counts[n]}`).join(", ") || "(basics only)"}`);
  }
}

console.log("\n" + "#".repeat(72));
console.log("SUMMARY — mean nonbasic Jaccard vs pros (higher = closer to real lists)");
console.log("#".repeat(72));
for (const [k] of METHODS) {
  const a = agg[k];
  const mean = a.jac.reduce((s, x) => s + x, 0) / (a.jac.length || 1);
  console.log(`  ${k.padEnd(14)} mean J ${mean.toFixed(3)}   new-wave lands picked (across ${DECKS.length} decks): ${a.newWave}`);
}
