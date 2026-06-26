"""Land identification, "best printing" dedup, and mana production.

Covers two roadmap concerns:
  * #2 -- the land filter + best-printing sort, extracted from the GUI scripts.
  * #5 -- mapping a land (or any card) to the colors it produces, and tallying
          a selection of lands into per-color source counts.
"""

from core.util import list_of_seq_unique_by_key

# The five colors of mana, in WUBRG order. 'C' (colorless) is intentionally
# excluded -- a colorless source does not satisfy a colored requirement.
COLORS = ("W", "U", "B", "R", "G")

def is_land(card):
    """True if the card is a land.

    Checks for the "Land" card type in the part of the type line before the
    subtype dash, so typed lands count too -- e.g. "Land — Plains Island"
    (shock/dual lands), "Basic Land — Forest", "Snow Land", "Artifact Land",
    "Land Creature — ..." (manlands). The old check only accepted a bare "Land"
    / "Legendary Land" / "Basic Land", which silently dropped every dual-typed
    land from the grid.
    """
    type_line = card.get("type_line", "") or ""
    return "Land" in type_line.split("—")[0]


def produced_colors(card):
    """Set of colored mana symbols (subset of WUBRG) the card can produce."""
    produced = card.get("produced_mana") or []
    return {c for c in COLORS if c in produced}


def filter_lands(cards):
    """All land cards from a Scryfall card list."""
    return [c for c in cards if is_land(c)]


def is_basic(card):
    """True if the card is a basic land."""
    return "Basic" in (card.get("type_line", "") or "")


def _printing_rank(card):
    """Rank a printing for dedup (higher is preferred, used with reverse=True).

    The old key carried several dead comparisons (e.g. ``border_color[0] ==
    'borderless'``, which compares one character to a whole word). Replaced with
    a simple, correct preference: a high-resolution image, then the most recent
    printing. (Scryfall is already queried with ``unique=cards``, so this mainly
    guards against the occasional duplicate.)
    """
    return (card.get("highres_image") is True, card.get("released_at") or "")


def unique_lands(cards):
    """Land cards deduped to one printing per name (newest hi-res wins)."""
    lands = sorted(filter_lands(cards), key=_printing_rank, reverse=True)
    return list_of_seq_unique_by_key(lands, "name")


def tally_sources(lands_with_counts):
    """Tally a chosen manabase into per-color source counts.

    ``lands_with_counts`` is an iterable of ``(card, count)`` pairs. A land
    contributes its count to every color it produces (a dual land counts for
    both). Returns a dict over WUBRG plus a ``'total'`` of all land copies.
    """
    tally = {c: 0 for c in COLORS}
    tally["total"] = 0
    for card, count in lands_with_counts:
        for color in produced_colors(card):
            tally[color] += count
        tally["total"] += count
    return tally
