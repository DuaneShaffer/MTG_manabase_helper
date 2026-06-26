"""Parse Arena/MTGO-style decklists into structured entries (#3).

Replaces the fragile ``' '.join(line.split()[1:-2])`` one-liner from
``mtg_test.py``, which discarded quantities and silently produced empty names
for malformed lines. The format, one card per line, looks like::

    Deck
    4 Adarkar Wastes (DMU) 243
    2 Teferi, Who Slows the Sunset (MID) 245

    Sideboard
    1 Negate (RIX) 44

Section headers (``Deck`` / ``Sideboard``) and blank lines are handled; each
parsed card records which section it came from.
"""

from collections import namedtuple

DeckEntry = namedtuple("DeckEntry", ["qty", "name", "set", "collector", "section"])


def _parse_line(line, section):
    """Parse one line into a DeckEntry, or return ``None`` if it isn't a card.

    A card line starts with an integer quantity. Lines that don't (section
    headers, blanks) return ``None`` so the caller can treat them as headers.
    """
    tokens = line.split()
    if not tokens or not tokens[0].isdigit():
        return None

    qty = int(tokens[0])
    # Standard export: trailing "(SET) COLLECTOR". The set token is parenthesized,
    # which lets us separate it from multi-word card names reliably.
    if len(tokens) >= 4 and tokens[-2].startswith("("):
        set_code = tokens[-2].strip("()")
        collector = tokens[-1]
        name = " ".join(tokens[1:-2])
    else:
        # Bare "QTY Name" with no set/collector metadata.
        set_code = None
        collector = None
        name = " ".join(tokens[1:])

    if not name:
        return None
    return DeckEntry(qty, name, set_code, collector, section)


def parse_decklist_text(text):
    """Parse decklist text into a list of :class:`DeckEntry`."""
    entries = []
    section = "deck"
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        entry = _parse_line(line, section)
        if entry is None:
            # A non-card line is a section header; remember it for what follows.
            section = stripped.lower()
            continue
        entries.append(entry)
    return entries


def parse_decklist_file(path):
    """Parse a decklist file into a list of :class:`DeckEntry`."""
    with open(path, "r") as fh:
        return parse_decklist_text(fh.read())


def deck_entries(entries, section="deck"):
    """Filter parsed entries to a single section (the maindeck by default)."""
    return [e for e in entries if e.section == section]


def card_names(entries):
    """Distinct card names from parsed entries, preserving first-seen order."""
    seen = set()
    names = []
    for e in entries:
        if e.name not in seen:
            seen.add(e.name)
            names.append(e.name)
    return names
