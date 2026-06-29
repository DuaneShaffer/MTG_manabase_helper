"""Minimum colored-source requirements per color (Frank Karsten's table).

Given a deck's mana costs, compute how many sources of each color the manabase
should contain. The cost parser tokenises Scryfall mana strings properly
(``{1}{W}{W}`` -> one generic + two white), which fixes the old character-by-
character approach:

  * multi-digit generic costs like ``{10}`` are read as 10, not 1;
  * colorless ``{C}`` counts as generic pressure but does **not** mark a card
    multicolor (the old code wrongly treated it as gold);
  * two-color hybrid pips (``{W/U}``) are payable by *either* color, so rather
    than forcing both they lean on whichever color the deck is already most
    invested in (see :func:`requirements_for_cards`);
  * "twobrid" ``{2/W}`` (pay 2 generic or one W) folds into generic 2 -- you can
    always pay it without the color, so it adds no color pressure;
  * Phyrexian ``{W/P}`` folds into generic 1 (payable with life -- color
    pressure treated as zero, a documented simplification).

For each color a card needs, it's reduced to a "Karsten shape" -- generic plus
other-color pips form the leading number, this color's pips become trailing
``C``s -- and a multicolor card adds +1 (extra fixing pressure). Each color's
requirement is the max across every card that needs it.
"""

import re

from core import hypergeometric
from core.lands import COLORS

_TOKEN_RE = re.compile(r"\{([^}]+)\}")
_HYBRID_RE = re.compile(r"^([WUBRG])/([WUBRG])$")  # two-color hybrid, e.g. W/U
_TWOBRID_RE = re.compile(r"^2/[WUBRG]$")           # monocolored hybrid, e.g. 2/W
_PHYREXIAN_RE = re.compile(r"^[WUBRG]/P$")         # Phyrexian, e.g. W/P

DEFAULT_DECK_SIZE = 60

# Sources needed to reliably cast a spell of the given Karsten "shape", from
# Frank Karsten's manabase research. Keys read as (generic)(colored pips):
# '2CC' == {2}{C}{C}, 'CCC' == triple-pip with no generic.
FRANK_RECOMMENDATION = {
    "5C": 9, "4C": 9, "3C": 10, "2C": 12, "5CC": 12,
    "1C": 13, "4CC": 13, "C": 14, "3CC": 15, "4CCC": 16,
    "2CC": 16, "3CCC": 17, "1CC": 18, "2CCC": 19, "CC": 21,
    "1CCC": 21, "1CCCC": 22, "CCC": 23, "CCCC": 24,
}


def parse_cost(mana_cost):
    """Tokenise a mana cost into ``(generic, {color: pip_count}, hybrid)``.

    Colorless/snow pips fold into ``generic``; ``X`` tokens contribute nothing.
    ``hybrid`` is a list of two-color pairs (e.g. ``["W", "U"]`` for ``{W/U}``),
    each payable by either color and contributing 1 to mana value. Twobrid
    ``{2/W}`` folds into generic 2 and Phyrexian ``{W/P}`` into generic 1 (both
    add no color pressure).
    """
    generic = 0
    colored = {c: 0 for c in COLORS}
    hybrid = []
    for token in _TOKEN_RE.findall(mana_cost or ""):
        m = _HYBRID_RE.match(token)
        if token.isdigit():
            generic += int(token)
        elif token in colored:
            colored[token] += 1
        elif token in ("C", "S"):  # colorless / snow -> generic pressure
            generic += 1
        elif token in ("X", "Y", "Z"):  # variable cost contributes 0
            continue
        elif m:  # two-color hybrid: payable by either color
            hybrid.append([m.group(1), m.group(2)])
        elif _TWOBRID_RE.match(token):  # {2/W}: pay 2 generic or one W
            generic += 2
        elif _PHYREXIAN_RE.match(token):  # {W/P}: payable with life -> generic
            generic += 1
        else:  # anything else -> treat as generic
            generic += 1
    return generic, colored, hybrid


def karsten_shape(mana_cost, symbol):
    """Reduce a mana cost to its Karsten shape for one color.

    Returns ``(shape, is_gold)``; ``(None, False)`` if the color isn't in the
    cost. ``is_gold`` is True when the cost contains a pip of another color.
    Hybrid pips don't figure into the shape (they're resolved at the deck level).
    """
    generic, colored, _hybrid = parse_cost(mana_cost)
    pips = colored.get(symbol, 0)
    if pips == 0:
        return None, False
    other_colored = sum(v for c, v in colored.items() if c != symbol)
    lead = generic + other_colored
    shape = (str(lead) if lead else "") + "C" * pips
    return shape, other_colored > 0


def colors_in_cost(mana_cost):
    """The distinct hard WUBRG symbols appearing in a mana cost.

    Hybrid colors are excluded -- a hybrid doesn't force a specific color.
    """
    _, colored, _hybrid = parse_cost(mana_cost)
    return {c for c, v in colored.items() if v > 0}


def mana_value(mana_cost):
    """Total mana value of a cost (generic + colorless + all pips)."""
    generic, colored, hybrid = parse_cost(mana_cost)
    return generic + sum(colored.values()) + len(hybrid)


def cost_constraints(mana_cost):
    """Per-color casting constraints for a cost (hard pips only).

    Returns ``{color: (pips, mana_value, is_gold)}`` for each color the cost
    hard-requires. ``is_gold`` marks a multicolor card (>1 distinct hard color),
    which adds fixing pressure. Hybrid pips are resolved at the deck level by
    :func:`requirements_for_cards`, not here.
    """
    generic, colored, hybrid = parse_cost(mana_cost)
    mv = generic + sum(colored.values()) + len(hybrid)
    is_gold = sum(1 for c in COLORS if colored[c] > 0) > 1
    return {c: (colored[c], mv, is_gold) for c in COLORS if colored[c] > 0}


def sources_for(pips, mv, is_gold, deck_size=DEFAULT_DECK_SIZE, threshold=None):
    """Sources of one color needed for a single constraint (live hypergeometric).

    A multicolor card adds +1 (Karsten's simultaneous-color approximation).
    """
    base = hypergeometric.sources_needed(pips, mv, deck_size, threshold=threshold)
    return base + (1 if is_gold else 0)


def requirements_for_cards(cards, deck_size=DEFAULT_DECK_SIZE, threshold=None):
    """Per-color minimum sources for a list of Scryfall card dicts.

    Uses the live hypergeometric model. ``threshold`` overrides Karsten's sliding
    (89 + M)% confidence target with a flat value (e.g. 0.95).

    Two-color hybrid pips are payable by either color, so they don't force both.
    A first pass computes hard requirements (hybrid-free); a second pass assigns
    each hybrid pip to whichever of its two colors the deck already demands most
    (the least-cost relaxation -- you support it with a color you already run),
    folding that pip into the card's requirement for that color.
    """
    parsed = []
    hard = {c: 0 for c in COLORS}
    for card in cards:
        _generic, colored, hybrid = parse_cost(card.get("mana_cost", ""))
        mv = mana_value(card.get("mana_cost", ""))
        parsed.append((colored, hybrid, mv))
        is_gold = sum(1 for c in COLORS if colored[c] > 0) > 1
        for c in COLORS:
            if colored[c] > 0:
                hard[c] = max(hard[c], sources_for(colored[c], mv, is_gold, deck_size, threshold))

    requirements = {c: 0 for c in COLORS}
    for colored, hybrid, mv in parsed:
        pips = dict(colored)
        for pair in hybrid:
            # Lean the hybrid on the color the deck already needs most; ties go
            # to the earlier WUBRG color for a deterministic result.
            choice = max(pair, key=lambda c: (hard[c], -COLORS.index(c)))
            pips[choice] += 1
        active = [c for c in COLORS if pips[c] > 0]
        is_gold = len(active) > 1
        for c in active:
            need = sources_for(pips[c], mv, is_gold, deck_size, threshold)
            requirements[c] = max(requirements[c], need)
    return requirements


def requirements_for_costs(mana_costs, deck_size=DEFAULT_DECK_SIZE, threshold=None):
    """Per-color minimum sources for an iterable of mana cost strings."""
    return requirements_for_cards(
        [{"mana_cost": mc} for mc in mana_costs], deck_size, threshold,
    )
