"""Pre-fetch Scryfall data and write the slim JSON the static site ships with.

The static web app loads these committed files instead of hitting Scryfall's
API, so end users never touch Scryfall (only this build does — run weekly by a
GitHub Action). Card *images* still load from Scryfall's CDN via the stored URLs.

Run:  python scripts/build_data.py
Writes: docs/data/lands.json, docs/data/cards.json, docs/data/meta.json
"""

import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core import config, lands as land_mod, scryfall

OUT = config.REPO_ROOT / "docs" / "data"


def _uris(card):
    uris = card.get("image_uris")
    if not uris and card.get("card_faces"):
        uris = card["card_faces"][0].get("image_uris")
    return uris or {}


def _oracle(card):
    txt = card.get("oracle_text") or ""
    if not txt and card.get("card_faces"):
        txt = " ".join(f.get("oracle_text", "") for f in card["card_faces"])
    return txt


def _enters_tapped(oracle):
    """Best-effort: does the land enter tapped *unconditionally*?

    Shock lands ("you may pay 2 life... it enters tapped"), check/fast/slow lands
    ("enters tapped unless...") are conditionally untapped, so we don't flag them
    — only lands that always enter tapped (surveil/gain lands, etc.).
    """
    if "enters tapped" not in oracle and "enters the battlefield tapped" not in oracle:
        return False
    conditional = any(kw in oracle for kw in ("unless", "you may pay", "if you don"))
    return not conditional


def slim_land(card):
    uris = _uris(card)
    return {
        "name": card["name"],
        "type": card.get("type_line", ""),
        "rarity": card.get("rarity", ""),
        "colors": sorted(land_mod.produced_colors(card)),
        "image": uris.get("small"),
        "image_hi": uris.get("normal"),
        "basic": land_mod.is_basic(card),
        "tapped": _enters_tapped(_oracle(card).lower()),
    }


def _smooths(card):
    """Cheap card-draw / ramp that smooths your draws (Karsten's land-count input).

    True for low-mana-value cards that draw, dig (scry/surveil), tutor a land, or
    ramp (a nonland that taps for mana). Used to shave the recommended land count.
    """
    if (card.get("cmc", 0) or 0) > 3:
        return False
    type_line = card.get("type_line", "") or ""
    oracle = _oracle(card).lower()
    if "Land" not in type_line.split("—")[0] and card.get("produced_mana"):
        return True  # mana dork / rock
    if "search your library for" in oracle and "land" in oracle:
        return True  # cheap land ramp / fetch
    # card draw / selection, across the common phrasings
    SIGNALS = ("draw", "scry", "surveil", "look at the top", "into your hand")
    return any(s in oracle for s in SIGNALS)


def slim_card(card):
    cost = card.get("mana_cost") or ""
    if not cost and card.get("card_faces"):
        cost = card["card_faces"][0].get("mana_cost", "") or ""
    return {
        "name": card["name"],
        "cost": cost,
        "type": card.get("type_line", ""),
        "image": _uris(card).get("small"),
        "smooth": _smooths(card),
    }


def main():
    OUT.mkdir(parents=True, exist_ok=True)

    raw_lands = scryfall.standard_lands(force_refresh=True)
    lands = [slim_land(c) for c in land_mod.unique_lands(raw_lands)]
    with open(OUT / "lands.json", "w") as fh:
        json.dump(lands, fh, separators=(",", ":"))

    all_cards = scryfall._search_all("legal:standard", unique="cards")
    cards = {c["name"].lower(): slim_card(c) for c in all_cards}
    with open(OUT / "cards.json", "w") as fh:
        json.dump(cards, fh, separators=(",", ":"))

    meta = {
        "generated": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%MZ"),
        "lands": len(lands),
        "cards": len(cards),
    }
    with open(OUT / "meta.json", "w") as fh:
        json.dump(meta, fh)

    print("wrote {} lands, {} cards ({})".format(len(lands), len(cards), meta["generated"]))


if __name__ == "__main__":
    main()
