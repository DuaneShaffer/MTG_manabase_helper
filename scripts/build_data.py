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

    The conditional keywords are scoped to the *sentence* that says it enters
    tapped, so an unrelated "unless"/"pay" elsewhere (e.g. a sacrifice drawback
    like Command Bridge's) doesn't wrongly mark an always-tapped land as untapped.
    """
    for sentence in re.split(r"[.\n]", oracle):
        if "enters tapped" in sentence or "enters the battlefield tapped" in sentence:
            conditional = any(kw in sentence for kw in ("unless", "you may pay", "if you don"))
            return not conditional
    return False


_BASIC_TYPES = {"Plains": "W", "Island": "U", "Swamp": "B", "Mountain": "R", "Forest": "G"}
# A mana ability's cost is "acceptable" for fixing if it's a bare tap or a tap with
# a life payment (painland-style: "{T}, Pay 1 life: Add any color"). It is NOT
# acceptable if it costs *generic mana* — a "{1},{T}: Add any color" filter doesn't
# give you a usable colored source for casting on curve (it just converts mana you
# already have), so such lands must not count as colored fixing. Also reject
# sacrifice / exile / discard / tap-another-permanent costs.
_BAD_COST = re.compile(r"sacrifice|tap an|tap a |tap two|exile|discard|remove|\{\d+\}")


def analyze_land_colors(card):
    """Classify a land's color output into (reliable, conditional, condition,
    type_gated, type_gate).

    ``reliable``    — colors it makes for general fixing (free or life-cost taps,
                      including "any color"/"choose a color" lands).
    ``conditional`` — colors gated to a spell type ("Spend this mana only to cast
                      a creature/Hero/artifact spell"); only real when the deck
                      has enough of that type.
    ``condition``   — the spell-type keyword for the conditional colors.
    ``type_gated``  — colors gated on *controlling a basic land type* (the "Verge"
                      cycle: "{T}: Add {B}. Activate only if you control an Island
                      or a Swamp."). Real only if the build supplies those types.
    ``type_gate``   — the basic land types that enable ``type_gated`` colors.

    Scryfall's ``produced_mana`` over-reports (it lists every color a land *can*
    make, however restricted/costly), so we parse the abilities instead.
    """
    produced = set(card.get("produced_mana") or []) & set("WUBRG")
    type_line = card.get("type_line", "") or ""
    if not produced:
        return [], [], None, [], []
    if any(t in type_line for t in _BASIC_TYPES):
        return sorted(produced), [], None, [], []  # typed land — genuine fixing

    reliable, conditional, condition = set(), set(), None
    type_gated, type_gate = set(), set()
    for line in _oracle(card).split("\n"):
        low = line.lower()
        if "add" not in low or ":" not in line:
            continue
        cost = line.split(":", 1)[0].lower()
        if "{t}" not in cost or _BAD_COST.search(cost):
            continue
        if "any color" in low or "any combination" in low or "any one color" in low or "chosen color" in low:
            colors = set("WUBRG") & produced
        else:
            colors = {s for s in "WUBRG" if "{" + s + "}" in line} & produced
        if not colors:
            continue
        # "Spend this mana only to cast a creature spell" / "an instant or sorcery"
        m = re.search(r"spend this mana only to cast (?:a |an )?([a-z]+(?: or [a-z]+)*)", low)
        # Verge: "Activate (this ability) only if you control a/an Island or a Swamp."
        mt = re.search(r"activate (?:this ability )?only if you control (.+)", low)
        if m:
            conditional |= colors
            condition = condition or m.group(1).replace(" spell", "").strip()
        elif mt:
            type_gated |= colors
            for t in _BASIC_TYPES:
                if t.lower() in mt.group(1):
                    type_gate.add(t)
        else:
            reliable |= colors
    return (sorted(reliable), sorted(conditional - reliable), condition,
            sorted(type_gated - reliable), sorted(type_gate))


def slim_land(card):
    uris = _uris(card)
    reliable, cond_colors, condition, gated_colors, type_gate = analyze_land_colors(card)
    out = {
        "name": card["name"],
        "type": card.get("type_line", ""),
        "rarity": card.get("rarity", ""),
        # A Verge's gated color IS real fixing once you control the basic type, so
        # it stays in `colors` (the land grades/tallies as a full dual); typeGate
        # below tells the optimizer to only lean on it when the build supplies the
        # enabling basic types.
        "colors": sorted(set(reliable) | set(gated_colors)),
        "image": uris.get("small"),
        "image_hi": uris.get("normal"),
        "basic": land_mod.is_basic(card),
        "tapped": _enters_tapped(_oracle(card).lower()),
    }
    if cond_colors and condition:
        out["condColors"] = cond_colors
        out["condition"] = condition
    if gated_colors and type_gate:
        out["gatedColors"] = gated_colors
        out["typeGate"] = type_gate
    return out


def _smooths(card):
    """Low-cost (<=3 MV) card-draw / ramp candidate.

    True for cards that draw, dig (scry/surveil), tutor a land, or ramp (a nonland
    that taps for mana). The web app refines this by mana value: <=2 MV smooths
    your early drops and trims the recommended land count, while 3 MV is treated as
    "card advantage" that helps the simulation reach lands for expensive spells but
    does NOT lower the land count (3-drops are too slow to fix early land drops).
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

    all_cards = scryfall._search_all("legal:standard " + scryfall.legality_cutoff(), unique="cards")
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
