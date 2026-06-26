// Validate the land RECOMMENDERS against real metagame decks.
//
// Compares every recommender heuristic the app ships — the greedy recommend()
// and the ILP optimizer's objectives (most-untapped / fewest-tapped / fewest-
// total) — to the pros' actual manabases, on three metrics:
//   - name Jaccard : overlap of the exact nonbasic cards chosen (strictest)
//   - sig  Jaccard : overlap of nonbasic *signatures* (colors + tapped) — does
//                    our manabase have the right SHAPE, ignoring which specific
//                    interchangeable dual got picked?
//   - sim parity   : Monte-Carlo on-curve cast rate of OUR build vs the PRO build
//                    (the real goal — picking different-but-equivalent lands is
//                    fine if the deck casts as reliably)
// Also reports how many brand-new-set lands each method reaches for.
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
const { manaValue, costConstraints } = await import(path.join(JS, "mana.js"));
const { simulateDeck } = await import(path.join(JS, "montecarlo.js"));

const cards = JSON.parse(fs.readFileSync(path.join(DATA, "cards.json"), "utf8"));
const landsArr = JSON.parse(fs.readFileSync(path.join(DATA, "lands.json"), "utf8"));
const landByName = new Map(landsArr.map((l) => [l.name.toLowerCase(), l]));
const DECKS = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/meta_decks.json"), "utf8"));
const landSets = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/land_sets.json"), "utf8"));

const NEW_WAVE = new Date("2026-06-26");
const SMOOTH_MAX_MV = 2;
const SIM_TRIALS = 1500;
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
// A land's "shape" signature: needed-color set + tapped. Two different dual cards
// with the same signature are interchangeable for manabase shape.
const sigOf = (name) => {
  const l = landByName.get(name.toLowerCase());
  return (l ? (l.colors || []).join("") : "") + (l && l.tapped ? "|T" : "|U");
};
const sigSet = (names) => names.map(sigOf);

// Build simulateDeck's land tokens from a {name: count} map.
function buildLandsFromCounts(counts) {
  const out = [];
  for (const [name, n] of Object.entries(counts)) {
    const l = landByName.get(name.toLowerCase());
    if (l && n > 0) out.push({ colors: l.colors || [], tapped: !!l.tapped, count: n });
  }
  return out;
}
// Distinct colored nonland spells for the simulator: {name, mv, pips}.
function buildSpells(resolved) {
  const out = [];
  for (const c of resolved) {
    if (isLandType(c.type)) continue;
    const cons = costConstraints(c.cost);
    const cols = Object.keys(cons);
    if (!cols.length) continue;
    const pips = {};
    for (const col of cols) pips[col] = cons[col].pips;
    out.push({ name: c.name, mv: manaValue(c.cost), pips });
  }
  return out;
}
// Deterministic PRNG so the pro vs. recommended sims face the same shuffles.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const simRate = (spells, counts, deckSize, drawCount, seed) =>
  spells.length
    ? simulateDeck(spells, buildLandsFromCounts(counts), deckSize, { trials: SIM_TRIALS, drawCount, rng: mulberry32(seed) }).overall
    : 1;

const METHODS = [
  ["greedy", async (req, t) => recommend(req, landsArr, { landTarget: t })],
  ...Object.keys(OBJECTIVES).map((obj) => [
    "ilp:" + obj,
    async (req, t) => optimizeManabase({ requirements: req, lands: landsArr, landTarget: t, objective: obj }),
  ]),
];

const agg = {};
for (const [k] of METHODS) agg[k] = { name: [], sig: [], simDelta: [], newWave: 0 };
let proSimSum = 0;

let deckIdx = 0;
for (const deck of DECKS) {
  const seed = 1000 + deckIdx++;
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
  const spells = buildSpells(resolved);

  // pro baseline
  const proCounts = {}, proNB = [];
  for (const e of entries) {
    const ld = landByName.get(e.name.toLowerCase());
    if (!ld) continue;
    proCounts[e.name] = (proCounts[e.name] || 0) + e.qty;
    if (!ld.basic) proNB.push(e.name);
  }
  const proSim = simRate(spells, proCounts, deckSize, smoothCount, seed);
  proSimSum += proSim;

  console.log("=".repeat(74));
  console.log(`${deck.archetype}   (target ~${landTarget} lands · pro cast-rate ${(proSim * 100).toFixed(0)}%)`);
  console.log(`  PRO nonbasics: ${proNB.map((n) => `${n}×${qtyByName[n]}`).join(", ")}`);
  for (const [k, run] of METHODS) {
    let res;
    try { res = await run(requirements, landTarget); }
    catch (e) { console.log(`  ${k.padEnd(14)} ERROR: ${e.message}`); continue; }
    const nb = nonbasics(res.counts);
    const jName = jaccard(nb, proNB);
    const jSig = jaccard(sigSet(nb), sigSet(proNB));
    const sim = simRate(spells, res.counts, deckSize, smoothCount, seed);
    const newPicked = nb.filter(isNewWave);
    agg[k].name.push(jName); agg[k].sig.push(jSig);
    agg[k].simDelta.push(sim - proSim); agg[k].newWave += newPicked.length;
    console.log(`  ${k.padEnd(14)} name J=${jName.toFixed(2)}  sig J=${jSig.toFixed(2)}  ` +
      `cast ${(sim * 100).toFixed(0)}% (${sim - proSim >= 0 ? "+" : ""}${((sim - proSim) * 100).toFixed(0)} vs pro)` +
      `${newPicked.length ? `  new: ${newPicked.join(", ")}` : ""}`);
  }
}

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
console.log("\n" + "#".repeat(74));
console.log(`SUMMARY across ${DECKS.length} decks   (pro mean cast-rate ${(proSimSum / DECKS.length * 100).toFixed(0)}%)`);
console.log("#".repeat(74));
console.log("method          name J   sig J   cast-rate Δ vs pro   new-wave picks");
for (const [k] of METHODS) {
  const a = agg[k];
  const d = mean(a.simDelta) * 100;
  console.log(`${k.padEnd(14)}  ${mean(a.name).toFixed(3)}   ${mean(a.sig).toFixed(3)}   ` +
    `${(d >= 0 ? "+" : "") + d.toFixed(1)}%`.padEnd(20) + `${a.newWave}`);
}
