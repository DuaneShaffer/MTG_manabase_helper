// Validate the manabase math against real metagame decks.
//
// Runs a fixture of current Standard decklists (tests/fixtures/meta_decks.json)
// through the app's ACTUAL eval modules (docs/js/*) and compares the app's
// recommendations to what the pros really built:
//   - recommended land COUNT vs the deck's actual land count
//   - per-color Karsten source MINIMUMS vs the sources the deck provides
//
// Mirrors app.js exactly: unweighted avgMV over distinct nonland cards, and only
// <=2 MV draw/ramp ("smooth") cards trim the land count.
//
// Run:  node scripts/validate_against_meta.mjs            (full report)
//       node scripts/validate_against_meta.mjs --smooth   (which cards are flagged smooth)
//
// Offline except for fixtures + docs/data; no network. Refresh decks by editing
// the fixture. This is a dev/analysis tool, not part of the app or CI.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const JS = path.join(ROOT, "docs/js");
const DATA = path.join(ROOT, "docs/data");

const { parseDeckText, deckEntries, cardNames } = await import(path.join(JS, "decklist.js"));
const { requirementsForCards } = await import(path.join(JS, "requirements.js"));
const { recommend, recommendLandCount } = await import(path.join(JS, "recommend.js"));
const { manaValue } = await import(path.join(JS, "mana.js"));
const { COLORS } = await import(path.join(JS, "colors.js"));

const cards = JSON.parse(fs.readFileSync(path.join(DATA, "cards.json"), "utf8"));
const landsArr = JSON.parse(fs.readFileSync(path.join(DATA, "lands.json"), "utf8"));
const landByName = new Map(landsArr.map((l) => [l.name.toLowerCase(), l]));
const DECKS = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/meta_decks.json"), "utf8"));

const SMOOTH_MAX_MV = 2; // mirror app.js
const isLandType = (type) => (type || "").split("—")[0].includes("Land");

function resolve(name) {
  const k = name.toLowerCase();
  if (cards[k]) return cards[k];
  const front = k.split(" / ")[0]; // mtgtop8 "Front / Back" -> our "front // back"
  if (cards[front]) return cards[front];
  for (const key of Object.keys(cards)) if (key.startsWith(front + " //")) return cards[key];
  return null;
}

const padL = (s, n) => String(s).padStart(n);
const SHOW_SMOOTH = process.argv.includes("--smooth");
const rows = [];

for (const deck of DECKS) {
  const entries = deckEntries(parseDeckText(deck.list), "deck");
  const qtyByName = {};
  let deckSize = 0;
  for (const e of entries) { qtyByName[e.name] = (qtyByName[e.name] || 0) + e.qty; deckSize += e.qty; }

  const resolved = cardNames(entries).map(resolve).filter(Boolean);
  const missing = cardNames(entries).filter((n) => !resolve(n));

  const requirements = requirementsForCards(resolved.map((c) => ({ cost: c.cost })), deckSize, null);
  const deckCards = resolved.filter((c) => !isLandType(c.type));
  const avgMV = deckCards.length
    ? deckCards.reduce((s, c) => s + manaValue(c.cost), 0) / deckCards.length : 3;

  const drawRamp = resolved.filter((c) => c.smooth && !isLandType(c.type));
  const cheap = drawRamp.filter((c) => manaValue(c.cost) <= SMOOTH_MAX_MV);
  const dig = drawRamp.filter((c) => manaValue(c.cost) > SMOOTH_MAX_MV);
  const smoothCount = cheap.reduce((s, c) => s + (qtyByName[c.name] || 0), 0);
  const landTarget = recommendLandCount(avgMV, deckSize, smoothCount);
  const targetNoDisc = recommendLandCount(avgMV, deckSize, 0);

  let actualLandCount = 0;
  const actualSources = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  const unknownLands = [];
  for (const e of entries) {
    const c = resolve(e.name);
    if (!c || !isLandType(c.type)) continue;
    actualLandCount += e.qty;
    const ld = landByName.get(e.name.toLowerCase());
    if (!ld) { unknownLands.push(e.name); continue; }
    for (const col of (ld.colors || [])) actualSources[col] += e.qty;
  }
  const rec = recommend(requirements, landsArr, { landTarget });
  rows.push({ a: deck.archetype, avgMV, smoothCount, actual: actualLandCount, target: landTarget, targetNoDisc });

  if (SHOW_SMOOTH) {
    console.log(`\n### ${deck.archetype}  — avgMV ${avgMV.toFixed(2)}`);
    console.log(`  cheap (<=2 MV, trims lands): ${cheap.map((c) => `${c.name}[${manaValue(c.cost)}]x${qtyByName[c.name]}`).join(", ") || "—"}`);
    console.log(`  dig (3 MV, sim only):        ${dig.map((c) => `${c.name}[${manaValue(c.cost)}]x${qtyByName[c.name]}`).join(", ") || "—"}`);
    console.log(`  smoothCount(<=2)=${smoothCount}  land target ${landTarget} (no-discount ${targetNoDisc}) | ACTUAL ${actualLandCount}`);
    continue;
  }

  console.log("\n" + "=".repeat(66));
  console.log(`${deck.archetype}   (${deckSize} cards, avgMV ${avgMV.toFixed(2)}, cheap-smooth ${smoothCount})`);
  console.log("=".repeat(66));
  console.log(`Lands:  actual ${actualLandCount}  |  app target ~${landTarget}  |  Δ ${actualLandCount - landTarget >= 0 ? "+" : ""}${actualLandCount - landTarget}  (no-discount ${targetNoDisc})`);
  console.log(`        app recommend(): ${rec.total} lands, ${rec.taplands} tapped` +
    (Object.keys(rec.shortfall).length ? `, short ${JSON.stringify(rec.shortfall)}` : ", every color covered"));
  console.log(`  color │ app min │ actual │ verdict`);
  for (const c of COLORS) {
    const req = requirements[c] || 0; const act = actualSources[c];
    if (req === 0 && act === 0) continue;
    console.log(`  ${c}     │ ${padL(req, 7)} │ ${padL(act, 6)} │ ${act >= req ? `ok (+${act - req})` : `short (${act - req})`}`);
  }
  if (unknownLands.length) console.log(`  ⚠ lands not in pool data: ${[...new Set(unknownLands)].join(", ")}`);
  if (missing.length) console.log(`  ⚠ unresolved: ${[...new Set(missing)].join(", ")}`);
}

if (!SHOW_SMOOTH) {
  console.log("\n" + "#".repeat(66));
  console.log("SUMMARY — land count (actual vs app target)");
  console.log("#".repeat(66));
  console.log("archetype                         avgMV  smc  actual  target   Δ   noDisc");
  let sumAbs = 0, sumAbsND = 0;
  for (const r of rows) {
    console.log(`${r.a.padEnd(33)}${r.avgMV.toFixed(2).padStart(5)}${padL(r.smoothCount, 5)}${padL(r.actual, 8)}${padL(r.target, 8)}${padL((r.actual - r.target >= 0 ? "+" : "") + (r.actual - r.target), 4)}${padL(r.targetNoDisc, 9)}`);
    sumAbs += Math.abs(r.actual - r.target);
    sumAbsND += Math.abs(r.actual - r.targetNoDisc);
  }
  console.log(`\nMean |Δ| with app's <=2MV discount: ${(sumAbs / rows.length).toFixed(2)} lands`);
  console.log(`Mean |Δ| with NO discount:          ${(sumAbsND / rows.length).toFixed(2)} lands`);
}
