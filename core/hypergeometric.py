"""Live hypergeometric source-count model (replaces the static Karsten table).

Reproduces Frank Karsten's "sources needed" numbers (13 of 14 canonical 60-card
cells exactly; the lone turn-1 single-pip differs by ~2, a known soft spot) and
generalizes to any deck size, turn, pip count, and confidence target.

Model (Karsten's *conditional* castability):

    P(>= pips colored sources AND >= M lands by turn M)  /  P(>= M lands by turn M)

i.e. given that you have enough lands to cast it on curve, how often do enough of
them make the right color. Conditioning on lands matters because colored sources
*are* lands. By turn T on the play you've seen ``7 + (T-1)`` cards. The default
confidence target is Karsten's sliding ``(89 + M)%``; callers may override it
with a flat target.

All the heavy counting is memoised -- the engine is called with the same small
integer arguments constantly (per color, per build change), so caching turns it
into table lookups after the first evaluation.
"""

import math
from functools import lru_cache

THRESHOLD_CAP = 0.99  # targets above this can be unreachable; clamp

# Karsten's 60-card analysis assumes ~25 lands; scale that ratio for other sizes.
def assumed_land_count(deck_size):
    return max(1, round(deck_size * 25 / 60))


def cards_seen(turn, on_play=True):
    """Cards seen by the given turn (opening 7 plus one per draw step)."""
    return 7 + (turn - 1) if on_play else 7 + turn


@lru_cache(maxsize=None)
def hypergeom_at_least(population, successes, sample, k):
    """P(draw >= k successes) for a sample of ``sample`` from ``population``.

    Plain (unconditional) hypergeometric: X ~ Hypergeometric(N=population,
    K=successes, n=sample). Used by the open-ended "odds of drawing N copies by
    turn T" tool, distinct from the conditional castability model above.
    """
    if k <= 0:
        return 1.0
    sample = min(sample, population)
    if k > successes or k > sample:
        return 0.0
    denom = math.comb(population, sample)
    if denom == 0:
        return 0.0
    lo = max(k, sample - (population - successes))
    hi = min(successes, sample)
    numer = sum(
        math.comb(successes, x) * math.comb(population - successes, sample - x)
        for x in range(lo, hi + 1)
    )
    return numer / denom


def draw_odds_by_turn(deck_size, successes, k, turn, on_play=True):
    """P(>= k of ``successes`` copies seen by ``turn``), on the play or draw."""
    return hypergeom_at_least(deck_size, successes, cards_seen(turn, on_play), k)


def threshold_for(mana_value):
    """Karsten's sliding confidence target: (89 + M)%, clamped."""
    return min((89 + mana_value) / 100.0, THRESHOLD_CAP)


@lru_cache(maxsize=None)
def _conditional_prob(pips, mana_value, deck_size, lands, sources, seen):
    """P(>=pips colored AND >=M lands | seen) / P(>=M lands | seen). Memoised.

    Three deck categories: ``sources`` colored sources, ``lands - sources`` other
    lands, the rest nonland. ``sources`` is capped at ``lands`` by the caller.
    """
    M = mana_value
    other_lands = lands - sources
    nonland = deck_size - lands
    numerator = 0
    for a in range(pips, min(sources, seen) + 1):          # colored drawn
        for b in range(max(0, M - a), min(other_lands, seen - a) + 1):  # other lands
            numerator += (
                math.comb(sources, a)
                * math.comb(other_lands, b)
                * math.comb(nonland, seen - a - b)
            )
    denominator = sum(
        math.comb(lands, t) * math.comb(deck_size - lands, seen - t)
        for t in range(M, min(lands, seen) + 1)
    )
    return numerator / denominator if denominator else 0.0


def castable_probability(pips, mana_value, sources, deck_size=60, lands=None,
                         on_play=True):
    """Probability of casting a ``pips``-pip, MV-``mana_value`` spell on curve
    given ``sources`` colored sources in the deck. 1.0 if no pips required."""
    if pips <= 0:
        return 1.0
    if lands is None:
        lands = assumed_land_count(deck_size)
    sources = min(sources, lands)
    seen = cards_seen(max(mana_value, pips), on_play)
    return _conditional_prob(pips, mana_value, deck_size, lands, sources, seen)


@lru_cache(maxsize=None)
def sources_needed(pips, mana_value, deck_size=60, lands=None, threshold=None,
                   on_play=True):
    """Smallest in-deck colored-source count to hit the confidence target.

    ``threshold`` overrides the sliding default (e.g. pass 0.95 for a flat 95%).
    """
    if pips <= 0:
        return 0
    if lands is None:
        lands = assumed_land_count(deck_size)
    target = threshold if threshold is not None else threshold_for(mana_value)
    seen = cards_seen(max(mana_value, pips), on_play)
    for sources in range(pips, lands + 1):
        if _conditional_prob(pips, mana_value, deck_size, lands, sources, seen) >= target:
            return sources
    return lands


# Letter grades for a build's actual probability, for the "how confident am I?"
# readout. Bands chosen to bracket Karsten's ~90% target.
_GRADE_BANDS = [
    (0.95, "A", "Excellent"),
    (0.90, "B", "Good"),
    (0.80, "C", "Risky"),
    (0.65, "D", "Poor"),
    (0.0, "F", "Unreliable"),
]


def grade(probability):
    """Map a probability to a ``(letter, label)`` grade."""
    for floor, letter, label in _GRADE_BANDS:
        if probability >= floor:
            return letter, label
    return "F", "Unreliable"
