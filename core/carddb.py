"""Resolve card names against a Scryfall card list.

Bridges the decklist parser (#3) and the requirements calculator (#4): given
the names in a deck, pull the matching card dicts, keeping the most recent
printing of each (matching the original ``mtg_test.py`` behaviour).
"""

from core.util import list_of_seq_unique_by_key


def cards_by_names(card_data, names):
    """Return one card dict per requested name, preferring the latest printing.

    Sorts matches by release date (newest first) and dedupes by name, so each
    name resolves to its most recent printing. Names with no match are dropped.
    """
    wanted = set(names)
    matching = [c for c in card_data if c.get("name") in wanted]
    matching = sorted(matching, key=lambda c: c.get("released_at", ""), reverse=True)
    return list_of_seq_unique_by_key(matching, "name")
