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
//         [--trials=N]            sim trials per build (default 400; CI-friendly)
//         [--new-wave=YYYY-MM-DD] "brand-new set" cutoff (default: 30 days before
//                                 docs/data/meta.json's generated timestamp)
//         [--decks=path]          alternate deck fixture
//         [--solve-budget=ms]     per-ILP-solve time box (default 10000); a solve
//                                 that blows it is a FAILURE — it would hang the
//                                 browser's Recommend button just the same
//
// Offline; runs in CI as a gate. Pro lists are a sanity signal, not ground
// truth — many valid manabases exist, so don't expect Jaccard 1.0. The gates
// are loose floors that catch real regressions (a method erroring out, leaving
// a color short, or casting far worse than the pro build). Fixture decks that
// reference rotated-out cards are SKIPPED with a warning, never hard-failed.
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const JS = path.join(ROOT, "docs/js");
const DATA = path.join(ROOT, "docs/data");

const { parseDeckText, deckEntries, cardNames } = await import(path.join(JS, "decklist.js"));
const { requirementsForCards } = await import(path.join(JS, "requirements.js"));
const { recommend, recommendLandCount } = await import(path.join(JS, "recommend.js"));
const { OBJECTIVES } = await import(path.join(JS, "optimize.js"));
const { manaValue, costConstraints } = await import(path.join(JS, "mana.js"));
const { simulateDeck } = await import(path.join(JS, "montecarlo.js"));

// ILP solves run in a worker thread so a pathological branch-and-cut can be
// time-boxed (jsLPSolver is synchronous; the parent can't interrupt it in-thread).
// The worker loads the vendored browser solver into its global as window.solver
// (the same shim the optimizer's tests use; module/exports/require are shadowed
// to undefined so the UMD header takes the browser path, not require("./main")),
// applies land popularity if the snapshot exists (a corpus disjoint from the
// fixtures below, so this measures the popularity-aware recommender), then
// solves jobs sent over the port. One worker is reused across all solves; it is
// terminated and respawned only after a budget overrun.
const WORKER_SRC = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
globalThis.window = globalThis;
const bundle = fs.readFileSync(workerData.solverPath, "utf8").replace(/^\\/\\* jsLPSolver[\\s\\S]*?\\*\\/\\n/, "");
(function (module, exports, require) { eval(bundle); }).call(globalThis, undefined, undefined, undefined);
(async () => {
  const { optimizeManabase, setLandPopularity } = await import(workerData.optimizePath);
  const landsArr = JSON.parse(fs.readFileSync(workerData.landsPath, "utf8"));
  try {
    const pop = JSON.parse(fs.readFileSync(workerData.popPath, "utf8"));
    if (pop && pop.lands) setLandPopularity(pop.lands);
  } catch { /* no snapshot yet — structural quality only */ }
  parentPort.on("message", async (job) => {
    try {
      const res = await optimizeManabase({ requirements: job.requirements, lands: landsArr,
        landTarget: job.landTarget, objective: job.objective });
      parentPort.postMessage({ ok: true, res });
    } catch (e) { parentPort.postMessage({ ok: false, error: e.message }); }
  });
})();
`;
const WORKER_DATA = {
  solverPath: path.join(JS, "vendor/lp-solver.js"),
  optimizePath: path.join(JS, "optimize.js"),
  landsPath: path.join(DATA, "lands.json"),
  popPath: path.join(DATA, "land_popularity.json"),
};
let ilpWorker = null;
function ilpSolve(job, budgetMs) {
  return new Promise((resolve) => {
    if (!ilpWorker) ilpWorker = new Worker(WORKER_SRC, { eval: true, workerData: WORKER_DATA });
    const w = ilpWorker;
    const onMsg = (m) => { clearTimeout(timer); w.off("error", onErr); resolve(m); };
    const onErr = (e) => { clearTimeout(timer); w.off("message", onMsg); ilpWorker = null; resolve({ ok: false, error: e.message }); };
    const timer = setTimeout(() => {
      w.off("message", onMsg); w.off("error", onErr);
      ilpWorker = null; w.terminate();
      resolve({ timedOut: true });
    }, budgetMs);
    w.once("message", onMsg);
    w.once("error", onErr);
    w.postMessage(job);
  });
}

const cards = JSON.parse(fs.readFileSync(path.join(DATA, "cards.json"), "utf8"));
const landsArr = JSON.parse(fs.readFileSync(path.join(DATA, "lands.json"), "utf8"));
const landByName = new Map(landsArr.map((l) => [l.name.toLowerCase(), l]));
const meta = JSON.parse(fs.readFileSync(path.join(DATA, "meta.json"), "utf8"));
const decksArg = process.argv.find((a) => a.startsWith("--decks="));
const DECKS = JSON.parse(fs.readFileSync(
  decksArg ? path.resolve(decksArg.slice(8)) : path.join(ROOT, "tests/fixtures/meta_decks.json"), "utf8"));
const landSets = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/land_sets.json"), "utf8"));

// "New wave" = lands from a just-released set (informational: is the recommender
// over-reaching for unproven lands?). Cutoff defaults to 30 days before the data
// snapshot's generated timestamp — never a frozen literal — and can be pinned
// with --new-wave=YYYY-MM-DD.
const nwArg = process.argv.find((a) => a.startsWith("--new-wave="));
const NEW_WAVE = nwArg
  ? new Date(nwArg.slice(11))
  : new Date(new Date(meta.generated).getTime() - 30 * 86400e3);
if (isNaN(NEW_WAVE)) { console.error("FAIL validate_recommender: bad --new-wave / meta.json generated date"); process.exit(1); }
const SMOOTH_MAX_MV = 2;
const trialsArg = process.argv.find((a) => a.startsWith("--trials="));
const SIM_TRIALS = trialsArg ? Math.max(1, +trialsArg.slice(9) || 0) : 400;
const budgetArg = process.argv.find((a) => a.startsWith("--solve-budget="));
const SOLVE_BUDGET = budgetArg ? Math.max(100, +budgetArg.slice(15) || 0) : 10000; // ms per ILP solve

// Pass/fail floors (loose by design; see header).
const MIN_SIG_J = 0.2;                 // mean shape-overlap floor, every method
const MIN_SIM_DELTA = -0.05;           // mean cast-rate vs pro floor
const MIN_SIM_DELTA_MINLANDS = -0.15;  // ilp:lands trades cast rate for fewer lands on purpose
const MIN_SAMPLE = 3;                  // don't apply mean floors to fewer decks (single-deck variance)
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

// Every method resolves to { ok, res } ({ timedOut } if the ILP blew its budget).
const METHODS = [
  ["greedy", async (req, t) => ({ ok: true, res: recommend(req, landsArr, { landTarget: t }) })],
  ...Object.keys(OBJECTIVES).map((obj) => [
    "ilp:" + obj,
    (req, t) => ilpSolve({ requirements: req, landTarget: t, objective: obj }, SOLVE_BUDGET),
  ]),
];

const agg = {};
for (const [k] of METHODS) agg[k] = { name: [], sig: [], simDelta: [], newWave: 0 };
let proSimSum = 0;
const failures = [];
let validated = 0, skipped = 0;

let deckIdx = 0;
for (const deck of DECKS) {
  const seed = 1000 + deckIdx++;
  const entries = deckEntries(parseDeckText(deck.list), "deck");
  const qtyByName = {}; let deckSize = 0;
  for (const e of entries) { qtyByName[e.name] = (qtyByName[e.name] || 0) + e.qty; deckSize += e.qty; }
  const resolved = cardNames(entries).map(resolve).filter(Boolean);
  // Fixture rot: skip decks whose cards (or lands) fell out of the current data
  // snapshot — that's a stale fixture (rotation), not a recommender bug.
  const missing = cardNames(entries).filter((n) => !resolve(n));
  const rottenLands = entries
    .filter((e) => { const c = resolve(e.name); return c && isLandType(c.type) && !landByName.get(e.name.toLowerCase()); })
    .map((e) => e.name);
  if (missing.length || rottenLands.length) {
    console.log(`SKIP ${deck.archetype}: not in current data (rotation?) — ${[...new Set([...missing, ...rottenLands])].join(", ")}`);
    skipped++;
    continue;
  }
  validated++;
  const requirements = requirementsForCards(resolved.map((c) => ({ cost: c.cost })), deckSize, null);
  const deckCards = resolved.filter((c) => !isLandType(c.type));
  const avgMV = deckCards.length ? deckCards.reduce((s, c) => s + manaValue(c.cost), 0) / deckCards.length : 3;
  const smoothCount = resolved.filter((c) => c.smooth && !isLandType(c.type) && manaValue(c.cost) <= SMOOTH_MAX_MV)
    .reduce((s, c) => s + (qtyByName[c.name] || 0), 0);
  const spells = buildSpells(resolved);

  // pro baseline
  const proCounts = {}, proNB = [];
  let proLandCount = 0;
  for (const e of entries) {
    const ld = landByName.get(e.name.toLowerCase());
    if (!ld) continue;
    proCounts[e.name] = (proCounts[e.name] || 0) + e.qty;
    proLandCount += e.qty;
    if (!ld.basic) proNB.push(e.name);
  }
  // Test the recommender at the PRO's land count so this measures land SELECTION,
  // not the (separately validated) land-count formula. recommendLandCount shown
  // for reference only.
  const landTarget = proLandCount || recommendLandCount(avgMV, deckSize, smoothCount);
  const proSim = simRate(spells, proCounts, deckSize, smoothCount, seed);
  proSimSum += proSim;

  console.log("=".repeat(74));
  console.log(`${deck.archetype}   (target ~${landTarget} lands · pro cast-rate ${(proSim * 100).toFixed(0)}%)`);
  console.log(`  PRO nonbasics: ${proNB.map((n) => `${n}×${qtyByName[n]}`).join(", ")}`);
  for (const [k, run] of METHODS) {
    let out;
    try { out = await run(requirements, landTarget); }
    catch (e) { out = { ok: false, error: e.message }; }
    if (out.timedOut) {
      console.log(`  ${k.padEnd(14)} TIMEOUT: solve exceeded ${SOLVE_BUDGET}ms`);
      failures.push(`${deck.archetype} ${k}: ILP solve exceeded ${SOLVE_BUDGET}ms budget (would hang the browser too)`);
      continue;
    }
    if (!out.ok) {
      console.log(`  ${k.padEnd(14)} ERROR: ${out.error}`);
      failures.push(`${deck.archetype} ${k}: threw "${out.error}"`);
      continue;
    }
    const res = out.res;
    // A shortfall (or infeasibility) is only a bug when the requirement was
    // reachable: we force the PRO's land count, and pros sometimes run fewer
    // lands than a color's Karsten minimum — then every manabase is "short".
    const structuralShort = (c) => (requirements[c] || 0) > landTarget;
    if (res.feasible === false && !Object.keys(requirements).some(structuralShort))
      failures.push(`${deck.archetype} ${k}: solver reported infeasible`);
    const unexcused = Object.keys(res.shortfall || {}).filter((c) => !structuralShort(c));
    if (unexcused.length)
      failures.push(`${deck.archetype} ${k}: left colors short ${JSON.stringify(res.shortfall)} with the full land pool`);
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

if (ilpWorker) ilpWorker.terminate(); // let the process exit after the summary

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
console.log("\n" + "#".repeat(74));
console.log(`SUMMARY across ${validated} decks (${skipped} skipped)   (pro mean cast-rate ${(proSimSum / (validated || 1) * 100).toFixed(0)}%)`);
console.log("#".repeat(74));
console.log("method          name J   sig J   cast-rate Δ vs pro   new-wave picks");
for (const [k] of METHODS) {
  const a = agg[k];
  const d = mean(a.simDelta) * 100;
  console.log(`${k.padEnd(14)}  ${mean(a.name).toFixed(3)}   ${mean(a.sig).toFixed(3)}   ` +
    `${(d >= 0 ? "+" : "") + d.toFixed(1)}%`.padEnd(20) + `${a.newWave}`);
  if (!a.simDelta.length) continue; // every deck errored/timed out — already recorded above
  if (a.simDelta.length < MIN_SAMPLE) {
    console.log(`  NOTE ${k}: only ${a.simDelta.length} deck(s) scored — mean floors not applied`);
    continue;
  }
  const floor = k === "ilp:lands" ? MIN_SIM_DELTA_MINLANDS : MIN_SIM_DELTA;
  if (mean(a.simDelta) < floor)
    failures.push(`${k}: mean cast-rate ${(mean(a.simDelta) * 100).toFixed(1)}% vs pro, below floor ${(floor * 100).toFixed(0)}%`);
  if (mean(a.sig) < MIN_SIG_J)
    failures.push(`${k}: mean sig Jaccard ${mean(a.sig).toFixed(3)} below floor ${MIN_SIG_J}`);
}

console.log(`\n${validated} deck(s) validated, ${skipped} skipped (stale fixtures).`);
if (!validated) {
  console.log("WARN: every fixture deck was skipped — refresh tests/fixtures/meta_decks.json after rotation. Nothing validated; passing vacuously.");
  process.exit(0);
}
if (failures.length) {
  console.error(`FAIL validate_recommender: ${failures.length} check(s) failed — ${failures[0]}`);
  for (const f of failures.slice(1)) console.error(`  also: ${f}`);
  process.exit(1);
}
console.log(`PASS validate_recommender: all methods within floors on ${validated} deck(s) (${SIM_TRIALS} trials).`);
