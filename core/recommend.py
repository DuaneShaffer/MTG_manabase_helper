"""Recommend a manabase: turn per-color requirements into concrete land counts.

A first-cut greedy heuristic (next_steps #9). Given how many sources of each
color the deck needs (:mod:`core.requirements`) and a pool of available lands,
it picks land copies that close the largest number of outstanding color
deficits per card -- so dual/triple lands that fix several needed colors are
preferred over basics, and basics top off whatever single-color gaps remain.

This is intentionally simple and explainable, not an optimiser. It does not yet
account for untapped-vs-tapped lands, curve, or a hard land-count target beyond
an optional cap; those are noted as further work.
"""

from collections import defaultdict

from core.lands import COLORS, is_basic, produced_colors

NONBASIC_MAX = 4  # singleton/playset rule for non-basic lands


def recommend(requirements, lands, max_lands=None):
    """Recommend land counts to satisfy per-color source ``requirements``.

    ``requirements``: dict over WUBRG of needed sources.
    ``lands``: iterable of Scryfall land dicts to choose from.
    ``max_lands``: optional cap on total lands; if reached before requirements
        are met, the remaining shortfall is reported instead of overshooting.

    Returns a dict with:
      ``counts``    -- {card_name: copies}
      ``cards``     -- {card_name: card_dict} for the chosen lands
      ``sources``   -- resulting {color: source_count}
      ``met``       -- {color: bool} whether each color's requirement is met
      ``total``     -- total land copies chosen
      ``shortfall`` -- {color: still-missing sources} (only colors > 0)
    """
    needed = {c for c in COLORS if requirements.get(c, 0) > 0}
    remaining = {c: requirements.get(c, 0) for c in COLORS}
    sources = {c: 0 for c in COLORS}
    counts = defaultdict(int)
    chosen = {}

    # Candidate pool: lands that produce at least one needed color, each tagged
    # with the colors it makes, whether it's a basic (unlimited copies), and how
    # many *off-colors* it makes (colors the deck doesn't need — wasted fixing).
    pool = []
    for card in lands:
        produced = produced_colors(card)
        if produced & needed:
            off = len(produced - needed)
            pool.append((card, produced, is_basic(card), off))
    # Name-sorted so ties resolve deterministically (not by input order).
    pool.sort(key=lambda t: t[0]["name"])

    total = 0
    while any(remaining[c] > 0 for c in COLORS):
        if max_lands is not None and total >= max_lands:
            break
        best = None
        best_key = None
        for card, colors, basic, off in pool:
            name = card["name"]
            # Use .get so probing the cap doesn't create a 0-count entry in the
            # defaultdict (which would pollute the returned counts).
            if not basic and counts.get(name, 0) >= NONBASIC_MAX:
                continue
            covered = sum(1 for c in colors if remaining[c] > 0)
            if covered == 0:
                continue
            # Prefer cards covering more deficits, then fewer wasted off-colors
            # (a focused dual over a rainbow land), then non-basics (the fixing
            # basics can't replace).
            key = (covered, -off, 0 if basic else 1)
            if best_key is None or key > best_key:
                best_key = key
                best = (card, colors)
        if best is None:
            break  # nothing left can help (shouldn't happen if basics exist)

        card, colors = best
        name = card["name"]
        counts[name] += 1
        chosen[name] = card
        total += 1
        for color in colors:
            sources[color] += 1
            if remaining[color] > 0:
                remaining[color] -= 1

    return {
        "counts": {name: n for name, n in counts.items() if n > 0},
        "cards": chosen,
        "sources": sources,
        "met": {c: sources[c] >= requirements.get(c, 0) for c in COLORS},
        "total": total,
        "shortfall": {c: remaining[c] for c in COLORS if remaining[c] > 0},
    }
