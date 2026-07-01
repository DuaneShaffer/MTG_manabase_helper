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
// the fixture. Runs in CI as a gate: exits nonzero if the app's land-count
// targets drift outside sanity bands vs the pro builds, or recommend() leaves a
// color short. Fixture decks that reference rotated-out cards are SKIPPED with
// a warning (refresh the fixture), never hard-failed.
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
const decksArg = process.argv.find((a) => a.startsWith("--decks="));
const DECKS = JSON.parse(fs.readFileSync(
  decksArg ? path.resolve(decksArg.slice(8)) : path.join(ROOT, "tests/fixtures/meta_decks.json"), "utf8"));

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

// Pass/fail bands (sanity gates, not exact goldens — pros disagree with any
// formula by a land or two; these catch real drift, not taste).
const TARGET_MIN = 15, TARGET_MAX = 32;   // sane land-count target for a 60-card deck
const MAX_DECK_ABS_DELTA = 6;             // |actual - target| for any single deck
const MAX_MEAN_ABS_DELTA = 3;             // mean |actual - target| across decks
const failures = [];
let validated = 0, skipped = 0;

for (const deck of DECKS) {
  const entries = deckEntries(parseDeckText(deck.list), "deck");
  const qtyByName = {};
  let deckSize = 0;
  for (const e of entries) { qtyByName[e.name] = (qtyByName[e.name] || 0) + e.qty; deckSize += e.qty; }

  const resolved = cardNames(entries).map(resolve).filter(Boolean);
  const missing = cardNames(entries).filter((n) => !resolve(n));
  // Fixture rot: the deck references cards no longer in docs/data (rotation).
  // Skip it — that's a stale fixture, not an app bug.
  if (missing.length) {
    console.log(`SKIP ${deck.archetype}: not in current card data (rotation?) — ${[...new Set(missing)].join(", ")}`);
    skipped++;
    continue;
  }
  validated++;

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

  // Gates: genuine logic errors, not fixture taste.
  if (!Object.values(requirements).some((v) => v > 0))
    failures.push(`${deck.archetype}: no colored requirements computed for a colored deck`);
  if (landTarget < TARGET_MIN || landTarget > TARGET_MAX)
    failures.push(`${deck.archetype}: land target ${landTarget} outside sane band [${TARGET_MIN},${TARGET_MAX}]`);
  if (actualLandCount && Math.abs(actualLandCount - landTarget) > MAX_DECK_ABS_DELTA)
    failures.push(`${deck.archetype}: |actual ${actualLandCount} - target ${landTarget}| > ${MAX_DECK_ABS_DELTA}`);
  if (Object.keys(rec.shortfall).length)
    failures.push(`${deck.archetype}: recommend() left colors short ${JSON.stringify(rec.shortfall)} with the full land pool`);

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
  if (rows.length && sumAbs / rows.length > MAX_MEAN_ABS_DELTA)
    failures.push(`mean |actual - target| ${(sumAbs / rows.length).toFixed(2)} > ${MAX_MEAN_ABS_DELTA} lands`);
}

console.log(`\n${validated} deck(s) validated, ${skipped} skipped (stale fixtures).`);
if (!validated) {
  console.log("WARN: every fixture deck was skipped — refresh tests/fixtures/meta_decks.json after rotation. Nothing validated; passing vacuously.");
  process.exit(0);
}
if (failures.length) {
  console.error(`FAIL validate_against_meta: ${failures.length} check(s) failed — ${failures[0]}`);
  for (const f of failures.slice(1)) console.error(`  also: ${f}`);
  process.exit(1);
}
console.log(`PASS validate_against_meta: ${validated} deck(s) within bands.`);
