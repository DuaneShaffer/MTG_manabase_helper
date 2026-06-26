// Validate the land RECOMMENDER against real metagame decks.
//
// For each fixture deck, runs recommend() on the full land pool and on a pool with
// the just-released wave removed (release >= NEW_WAVE), and compares both to the
// pros' actual nonbasic lands. Surfaces two things:
//   - how many brand-new-set lands the recommender reaches for, and
//   - how closely its nonbasic picks resemble real manabases (Jaccard).
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

const { parseDeckText, deckEntries, cardNames } = await import(path.join(JS, "decklist.js"));
const { requirementsForCards } = await import(path.join(JS, "requirements.js"));
const { recommend, recommendLandCount } = await import(path.join(JS, "recommend.js"));
const { manaValue } = await import(path.join(JS, "mana.js"));

const cards = JSON.parse(fs.readFileSync(path.join(DATA, "cards.json"), "utf8"));
const landsArr = JSON.parse(fs.readFileSync(path.join(DATA, "lands.json"), "utf8"));
const landByName = new Map(landsArr.map((l) => [l.name.toLowerCase(), l]));
const DECKS = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/meta_decks.json"), "utf8"));
const landSets = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/land_sets.json"), "utf8"));

const NEW_WAVE = new Date("2026-06-26"); // the most recent set as of the fixtures
const SMOOTH_MAX_MV = 2;
const isLandType = (type) => (type || "").split("—")[0].includes("Land");
const setOf = (name) => landSets[name]?.set || "?";
const isNewWave = (name) => {
  const rel = landSets[name]?.released_at;
  return rel ? new Date(rel) >= NEW_WAVE : false;
};
const poolFiltered = landsArr.filter((l) => !isNewWave(l.name));

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

let newWaveTotal = 0, jacFullSum = 0, jacFiltSum = 0;
console.log(`Filtered pool: ${poolFiltered.length}/${landsArr.length} lands (removed wave released >= ${NEW_WAVE.toISOString().slice(0, 10)})\n`);

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

  const recFull = recommend(requirements, landsArr, { landTarget });
  const recFilt = recommend(requirements, poolFiltered, { landTarget });
  const nbFull = nonbasics(recFull.counts);
  const nbFilt = nonbasics(recFilt.counts);
  const newPicked = nbFull.filter(isNewWave);
  newWaveTotal += newPicked.length;
  const jFull = jaccard(nbFull, proNB), jFilt = jaccard(nbFilt, proNB);
  jacFullSum += jFull; jacFiltSum += jFilt;

  console.log("=".repeat(70));
  console.log(`${deck.archetype}   (target ~${landTarget} lands)`);
  console.log(`  PRO nonbasics:   ${proNB.map((n) => `${n}×${qtyByName[n]}`).join(", ")}`);
  console.log(`  APP full pool:   ${nbFull.map((n) => `${n}×${recFull.counts[n]}${isNewWave(n) ? `*[${setOf(n)}]` : ""}`).join(", ")}`);
  console.log(`  APP no-new-wave: ${nbFilt.map((n) => `${n}×${recFilt.counts[n]}`).join(", ")}`);
  console.log(`  new-wave picked: ${newPicked.length ? newPicked.join(", ") : "none"}`);
  console.log(`  nonbasic Jaccard vs pro:  full ${jFull.toFixed(2)}  |  filtered ${jFilt.toFixed(2)}`);
}

console.log("\n" + "#".repeat(70));
console.log(`Total new-wave lands recommended across ${DECKS.length} decks (full pool): ${newWaveTotal}`);
console.log(`Mean nonbasic Jaccard vs pros:  full pool ${(jacFullSum / DECKS.length).toFixed(2)}  →  new-wave removed ${(jacFiltSum / DECKS.length).toFixed(2)}`);
