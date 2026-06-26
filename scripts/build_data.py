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
import re
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


_BASIC_TYPES = {"Plains": "W", "Island": "U", "Swamp": "B", "Mountain": "R", "Forest": "G"}


def reliable_colors(card):
    """Colors a land produces *for general fixing* — not conditional/costly mana.

    Scryfall's ``produced_mana`` lists every color a land can make, even when it's
    restricted ("Spend this mana only to cast a Hero spell") or gated behind a
    cost ("{4}, {T}: Add ..."). Those lands (e.g. Avengers Tower, Castle Doom)
    shouldn't read as 5-color fixing. We trust:
      * colors from basic land subtypes (they tap freely), and
      * colors from free ({T}-only), unrestricted "Add" abilities.
    """
    produced = set(card.get("produced_mana") or []) & set("WUBRG")
    if not produced:
        return []
    type_line = card.get("type_line", "") or ""
    if any(t in type_line for t in _BASIC_TYPES):
        return sorted(produced)  # typed land (shock/dual/etc.) — genuine fixing
    free = set()
    for line in _oracle(card).split("\n"):
        low = line.lower()
        if "add" not in low or ":" not in line:
            continue
        cost = line.split(":", 1)[0].lower()
        tap_only = "{t}" in cost and not re.search(r"\{\d|,|sacrifice|pay", cost)
        if not tap_only or "spend this mana only" in low:
            continue
        if "any color" in low or "any combination" in low:
            free |= set("WUBRG")
        else:
            free |= {s for s in "WUBRG" if "{" + s + "}" in line}
    return sorted(free & produced)


def conditional_fixing(card):
    """For lands whose any-color mana is restricted to a spell type, return
    ``(condColors, condition)`` — e.g. Avengers Tower -> (WUBRG, "hero"),
    Castle Doom -> (WUBRG, "artifact"). These become real fixing only when the
    deck has enough of that spell type. Cost-gated lands (no "spend this mana
    only") aren't conditional fixing and return ([], None)."""
    oracle = _oracle(card)
    low = oracle.lower()
    if "spend this mana only" not in low:
        return [], None
    if "any color" not in low and "any combination" not in low:
        return [], None
    produced = sorted(set(card.get("produced_mana") or []) & set("WUBRG"))
    m = re.search(r"to cast (?:a|an) ([a-z]+) spell", low)
    return produced, (m.group(1) if m else None)


def slim_land(card):
    uris = _uris(card)
    cond_colors, condition = conditional_fixing(card)
    out = {
        "name": card["name"],
        "type": card.get("type_line", ""),
        "rarity": card.get("rarity", ""),
        "colors": reliable_colors(card),
        "image": uris.get("small"),
        "image_hi": uris.get("normal"),
        "basic": land_mod.is_basic(card),
        "tapped": _enters_tapped(_oracle(card).lower()),
    }
    if cond_colors and condition:
        out["condColors"] = cond_colors
        out["condition"] = condition
    return out


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
