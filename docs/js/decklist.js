// Parse Arena/MTGO-style decklists into structured entries.
//
// Faithful port of core/decklist.py. The format, one card per line:
//
//     Deck
//     4 Adarkar Wastes (DMU) 243
//     2 Teferi, Who Slows the Sunset (MID) 245
//
//     Sideboard
//     1 Negate (RIX) 44
//
// Section headers (Deck / Sideboard) and blank lines are handled; each parsed
// card records which (lowercased) section it came from.

// A line starts with an integer quantity to be a card. Non-card lines (section
// headers, blanks) return null so the caller can treat them as headers.
function parseLine(line, section) {
  const tokens = line.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0 || !/^\d+$/.test(tokens[0])) {
    return null;
  }

  const qty = parseInt(tokens[0], 10);
  let set;
  let collector;
  let name;
  // Standard export: trailing "(SET) COLLECTOR". The set token is
  // parenthesized, which separates it from multi-word card names reliably.
  if (tokens.length >= 4 && tokens[tokens.length - 2].startsWith("(")) {
    set = tokens[tokens.length - 2].replace(/^\(+|\)+$/g, "");
    collector = tokens[tokens.length - 1];
    name = tokens.slice(1, tokens.length - 2).join(" ");
  } else {
    // Bare "QTY Name" with no set/collector metadata.
    set = null;
    collector = null;
    name = tokens.slice(1).join(" ");
  }

  if (!name) {
    return null;
  }
  return { qty, name, set, collector, section };
}

// Parse decklist text into a list of entries.
export function parseDeckText(text) {
  const entries = [];
  let section = "deck";
  for (const line of String(text).split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped) {
      continue;
    }
    const entry = parseLine(line, section);
    if (entry === null) {
      // A non-card line is a section header; remember it for what follows.
      section = stripped.toLowerCase();
      continue;
    }
    entries.push(entry);
  }
  return entries;
}

// Filter parsed entries to a single section (the maindeck by default).
export function deckEntries(entries, section = "deck") {
  return entries.filter((e) => e.section === section);
}

// Distinct card names from parsed entries, preserving first-seen order.
export function cardNames(entries) {
  const seen = new Set();
  const names = [];
  for (const e of entries) {
    if (!seen.has(e.name)) {
      seen.add(e.name);
      names.push(e.name);
    }
  }
  return names;
}
