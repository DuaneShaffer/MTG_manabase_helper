// Build docs/data/land_popularity.json from a raw deck-corpus tally.
//
// Input: a JSON file of the shape produced by scraping winning Standard decks:
//   { "sampledDecks": N, "lands": { "<land name>": { "decks": k, "copies": m } } }
// Output: per-land metagame inclusion stats the recommender uses to break ties
// toward the lands winning decks actually run (see optimize.js landQuality):
//   { generated, sampledDecks, lands: { "<name>": { decks, copies, score } } }
// where score = decks / sampledDecks (0..1 inclusion rate).
//
// Run:  node scripts/build_popularity.mjs <corpus.json>
//
// The corpus is gathered separately (MTGTop8 scrape) — keep it disjoint from
// tests/fixtures/meta_decks.json so validation isn't measuring against its own
// training data. Refresh on rotation; stale popularity misleads.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const corpusPath = process.argv[2];
if (!corpusPath) { console.error("usage: node scripts/build_popularity.mjs <corpus.json>"); process.exit(1); }

const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
const lands = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/data/lands.json"), "utf8"));
const known = new Map(lands.map((l) => [l.name.toLowerCase(), l.name]));
const resolveName = (n) => known.get(n.toLowerCase()) || known.get(n.replace(" / ", " // ").toLowerCase()) || null;

const sampled = corpus.sampledDecks || 0;
if (!sampled) { console.error("corpus has no sampledDecks"); process.exit(1); }

const out = { generated: new Date().toISOString().slice(0, 16) + "Z", sampledDecks: sampled, lands: {} };
let kept = 0, dropped = [];
for (const [rawName, v] of Object.entries(corpus.lands || {})) {
  const name = resolveName(rawName);
  if (!name) { dropped.push(rawName); continue; }
  out.lands[name] = { decks: v.decks, copies: v.copies, score: +(v.decks / sampled).toFixed(4) };
  kept++;
}

fs.writeFileSync(path.join(ROOT, "docs/data/land_popularity.json"), JSON.stringify(out));
console.log(`wrote land_popularity.json: ${kept} lands from ${sampled} decks` +
  (dropped.length ? `; dropped ${dropped.length} unknown names: ${dropped.slice(0, 8).join(", ")}${dropped.length > 8 ? "…" : ""}` : ""));
const top = Object.entries(out.lands).sort((a, b) => b[1].score - a[1].score).slice(0, 15);
console.log("top by inclusion:");
for (const [n, s] of top) console.log(`  ${(s.score * 100).toFixed(0)}%  ${n} (${s.decks}/${sampled}, ${(s.copies / s.decks).toFixed(1)} avg)`);
