"""Minimum colored-source requirements per color (Frank Karsten's table).

Given a deck's mana costs, compute how many sources of each color the manabase
should contain. The cost parser tokenises Scryfall mana strings properly
(``{1}{W}{W}`` -> one generic + two white), which fixes the old character-by-
character approach:

  * multi-digit generic costs like ``{10}`` are read as 10, not 1;
  * colorless ``{C}`` counts as generic pressure but does **not** mark a card
    multicolor (the old code wrongly treated it as gold);
  * hybrid / Phyrexian pips (``{W/U}``, ``{U/P}``, ``{2/W}``) are treated as
    generic for requirement purposes -- they're flexible to pay and don't force
    a specific color (a documented simplification).

For each color a card needs, it's reduced to a "Karsten shape" -- generic plus
other-color pips form the leading number, this color's pips become trailing
``C``s -- and a multicolor card adds +1 (extra fixing pressure). Each color's
requirement is the max across every card that needs it.
"""

import re

from core import hypergeometric
from core.lands import COLORS

_TOKEN_RE = re.compile(r"\{([^}]+)\}")

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
    """Tokenise a mana cost into ``(generic, {color: pip_count})``.

    Colorless/snow pips fold into ``generic``; hybrid/Phyrexian/``X`` tokens are
    treated as generic. Returns generic count and a dict over WUBRG.
    """
    generic = 0
    colored = {c: 0 for c in COLORS}
    for token in _TOKEN_RE.findall(mana_cost or ""):
        if token.isdigit():
            generic += int(token)
        elif token in colored:
            colored[token] += 1
        elif token in ("C", "S"):  # colorless / snow -> generic pressure
            generic += 1
        elif token in ("X", "Y", "Z"):  # variable cost contributes 0
            continue
        else:  # hybrid / Phyrexian / anything else -> treat as generic
            generic += 1
    return generic, colored


def karsten_shape(mana_cost, symbol):
    """Reduce a mana cost to its Karsten shape for one color.

    Returns ``(shape, is_gold)``; ``(None, False)`` if the color isn't in the
    cost. ``is_gold`` is True when the cost contains a pip of another color.
    """
    generic, colored = parse_cost(mana_cost)
    pips = colored.get(symbol, 0)
    if pips == 0:
        return None, False
    other_colored = sum(v for c, v in colored.items() if c != symbol)
    lead = generic + other_colored
    shape = (str(lead) if lead else "") + "C" * pips
    return shape, other_colored > 0


def colors_in_cost(mana_cost):
    """The distinct WUBRG symbols appearing in a mana cost."""
    _, colored = parse_cost(mana_cost)
    return {c for c, v in colored.items() if v > 0}


def mana_value(mana_cost):
    """Total mana value of a cost (generic + colorless + all pips)."""
    generic, colored = parse_cost(mana_cost)
    return generic + sum(colored.values())


def cost_constraints(mana_cost):
    """Per-color casting constraints for a cost.

    Returns ``{color: (pips, mana_value, is_gold)}`` for each color the cost
    needs. ``is_gold`` marks a multicolor card (>1 distinct color), which adds
    fixing pressure.
    """
    generic, colored = parse_cost(mana_cost)
    mv = generic + sum(colored.values())
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
    """
    requirements = {c: 0 for c in COLORS}
    for card in cards:
        for color, (pips, mv, is_gold) in cost_constraints(card.get("mana_cost", "")).items():
            need = sources_for(pips, mv, is_gold, deck_size, threshold)
            requirements[color] = max(requirements[color], need)
    return requirements


def requirements_for_costs(mana_costs, deck_size=DEFAULT_DECK_SIZE, threshold=None):
    """Per-color minimum sources for an iterable of mana cost strings."""
    return requirements_for_cards(
        [{"mana_cost": mc} for mc in mana_costs], deck_size, threshold,
    )
