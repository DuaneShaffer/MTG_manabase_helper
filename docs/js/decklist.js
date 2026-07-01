// Parse Arena/MTGO-style decklists into structured entries.
//
// Port of core/decklist.py, extended for third-party export quirks the app
// sees in the wild: "4x"/"x4" quantity tokens and headerless blank-line
// sideboards (see parseDeckText). The format, one card per line:
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

// Quantity token: a pure integer ("4"), or the common third-party export
// styles "4x" / "x4". Returns the quantity, or null if the token isn't one.
function parseQty(token) {
  const m = /^(\d+)x$/i.exec(token) || /^x(\d+)$/i.exec(token) || /^(\d+)$/.exec(token);
  return m ? parseInt(m[1], 10) : null;
}

// A line starts with a quantity token to be a card. Non-card lines (section
// headers, blanks) return null so the caller can treat them as headers.
function parseLine(line, section) {
  const tokens = line.split(/\s+/).filter((t) => t.length > 0);
  const qty = tokens.length ? parseQty(tokens[0]) : null;
  if (qty === null) {
    return null;
  }
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
//
// Sectioning works two ways:
//   - Explicit headers (Deck / Sideboard / Commander / ...): any non-blank,
//     non-card line names the section for the cards that follow. When a list
//     uses headers, blank lines are pure whitespace and never change sections
//     (so "Deck", a blank, then cards stays in the deck).
//   - Headerless exports: the common "maindeck, blank line, sideboard" shape
//     has no headers at all. Only when NO header appears anywhere in the list,
//     a blank line (or run of blanks) after at least one parsed card switches
//     everything that follows to the sideboard. Leading blank lines (before
//     any card) don't count.
export function parseDeckText(text) {
  const lines = String(text).split(/\r?\n/);
  // Pre-scan: does this list use explicit section headers? (Any non-blank line
  // that isn't a card line is a header.) If so, headers alone drive sectioning
  // and the blank-line heuristic below stays off.
  const hasHeaders = lines.some((l) => l.trim() && parseLine(l, "deck") === null);

  const entries = [];
  let section = "deck";
  let blankAfterCards = false; // headerless lists: pending blank-line section break
  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped) {
      if (!hasHeaders && entries.length > 0) blankAfterCards = true;
      continue;
    }
    if (blankAfterCards) {
      // Headerless export: the blank block separated maindeck from sideboard.
      section = "sideboard";
      blankAfterCards = false;
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
