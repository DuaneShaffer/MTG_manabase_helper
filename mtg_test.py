"""CLI: compute the minimum colored-source requirements for a decklist.

Reads a decklist, resolves each card against Scryfall (cached), and prints how
many sources of each color the manabase should contain (Frank Karsten's table).
Optionally recommends a concrete set of lands.

Usage:
    python mtg_test.py [DECKLIST] [--recommend]

With no decklist it analyses the bundled example deck.
"""

import argparse

from core import config, decklist, recommend, requirements, scryfall


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("deck", nargs="?", default=str(config.EXAMPLE_DECK),
                        help="decklist file (defaults to the bundled example deck)")
    parser.add_argument("--recommend", action="store_true",
                        help="also suggest a concrete manabase")
    args = parser.parse_args()

    entries = decklist.deck_entries(decklist.parse_decklist_file(args.deck), "deck")
    cards = scryfall.cards_by_names(decklist.card_names(entries))
    reqs = requirements.requirements_for_cards(cards)

    print("Minimum colored sources per color:")
    for color in requirements.COLORS:
        print("  {}: {}".format(color, reqs[color]))

    if args.recommend:
        rec = recommend.recommend(reqs, scryfall.standard_lands())
        print("\nRecommended manabase ({} lands):".format(rec["total"]))
        for name, count in sorted(rec["counts"].items(), key=lambda kv: -kv[1]):
            print("  {}x {}".format(count, name))
        if rec["shortfall"]:
            print("  (short: {})".format(rec["shortfall"]))


if __name__ == "__main__":
    main()
