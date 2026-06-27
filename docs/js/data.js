// Data layer for the static app.
// Land list + card index are served from committed JSON (data/*.json) so users
// never hit Scryfall's API. Only deck cards missing from the committed Standard
// index fall back to a direct Scryfall lookup (rare for a Standard tool).

let _cards = null;
let _cardsPromise = null;

export async function loadLands() {
  const res = await fetch("data/lands.json");
  if (!res.ok) throw new Error("lands.json " + res.status);
  return res.json();
}

export async function loadMeta() {
  try {
    return await (await fetch("data/meta.json")).json();
  } catch {
    return null;
  }
}

// Land popularity (metagame inclusion rate) for the recommender's land-quality
// tie-break. Optional: returns null if the snapshot isn't present.
export async function loadLandPopularity() {
  try {
    return await (await fetch("data/land_popularity.json")).json();
  } catch {
    return null;
  }
}

async function loadCards() {
  if (_cards) return _cards;
  if (!_cardsPromise) _cardsPromise = fetch("data/cards.json").then((r) => r.json());
  _cards = await _cardsPromise;
  return _cards;
}

const SCRYFALL = "https://api.scryfall.com";

function _slimScryfall(c) {
  const uris = c.image_uris || (c.card_faces && c.card_faces[0].image_uris) || {};
  let cost = c.mana_cost || "";
  if (!cost && c.card_faces) cost = c.card_faces[0].mana_cost || "";
  return { name: c.name, cost, type: c.type_line || "", image: uris.small };
}

// Resolve names the committed index doesn't have (e.g. non-Standard cards),
// querying Scryfall's collection endpoint in batches of 75.
async function scryfallFallback(names) {
  const found = {};
  for (let i = 0; i < names.length; i += 75) {
    const batch = names.slice(i, i + 75);
    try {
      const res = await fetch(SCRYFALL + "/cards/collection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifiers: batch.map((n) => ({ name: n })) }),
      });
      if (!res.ok) continue;
      const data = await res.json();
      for (const c of data.data || []) found[c.name.toLowerCase()] = _slimScryfall(c);
    } catch {
      /* offline / blocked — leave as missing */
    }
  }
  return found;
}

export async function resolveDeck(names) {
  const cards = await loadCards();
  const resolved = [];
  const localMissing = [];
  for (const n of names) {
    const c = cards[n.toLowerCase()];
    if (c) resolved.push(c);
    else localMissing.push(n);
  }
  let missing = localMissing;
  if (localMissing.length) {
    const extra = await scryfallFallback(localMissing);
    missing = [];
    for (const n of localMissing) {
      const c = extra[n.toLowerCase()];
      if (c) resolved.push(c);
      else missing.push(n);
    }
  }
  return { cards: resolved, missing };
}

export async function loadExampleDeck() {
  try {
    return await (await fetch("example_deck.txt")).text();
  } catch {
    return "";
  }
}
