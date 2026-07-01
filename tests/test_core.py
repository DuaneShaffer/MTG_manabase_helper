"""Tests for the Python data pipeline (core helpers + scripts/build_data.py).

Run with:  python -m pytest        (from the repo root)

The manabase math lives in the JS app (docs/js/) and is guarded by its own test
suite (docs/js/tests/); this file covers only the surviving Python surface: the
land identification/dedup helpers and the Scryfall snapshot builder.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))

import build_data
from core import lands
from core.util import list_of_seq_unique_by_key


# --------------------------------------------------------------------------
# util
# --------------------------------------------------------------------------
def test_unique_by_key_keeps_first():
    seq = [{"n": "a", "v": 1}, {"n": "b", "v": 2}, {"n": "a", "v": 3}]
    out = list_of_seq_unique_by_key(seq, "n")
    assert [x["v"] for x in out] == [1, 2]


# --------------------------------------------------------------------------
# lands
# --------------------------------------------------------------------------
def _land(name, produced, type_line="Land", **extra):
    base = {
        "name": name, "produced_mana": produced, "type_line": type_line,
        "set": "tst", "collector_number": "1", "oracle_text": "",
        "games": [], "released_at": "2020-01-01", "rarity": "rare",
    }
    base.update(extra)
    return base


def test_is_land():
    assert lands.is_land(_land("X", ["W"]))
    assert lands.is_land({"type_line": "Basic Land — Forest"})
    assert not lands.is_land({"type_line": "Creature — Elf"})


def test_produced_colors_excludes_colorless():
    assert lands.produced_colors(_land("X", ["W", "U", "C"])) == {"W", "U"}
    assert lands.produced_colors({"produced_mana": None}) == set()


def test_unique_lands_dedupes_by_name():
    cards = [
        _land("Dual", ["W", "U"], released_at="2019-01-01"),
        _land("Dual", ["W", "U"], released_at="2021-01-01"),
        _land("Mono", ["R"]),
        {"type_line": "Creature — Goblin", "name": "Not a land"},
    ]
    unique = lands.unique_lands(cards)
    names = [c["name"] for c in unique]
    assert names.count("Dual") == 1
    assert set(names) == {"Dual", "Mono"}


def test_tally_sources():
    dual = _land("Dual", ["W", "U"])
    mono = _land("Mono", ["R"])
    tally = lands.tally_sources([(dual, 4), (mono, 2)])
    assert tally["W"] == 4 and tally["U"] == 4 and tally["R"] == 2
    assert tally["total"] == 6


def test_is_basic():
    assert lands.is_basic({"type_line": "Basic Land — Forest"})
    assert not lands.is_basic({"type_line": "Land"})


def test_is_land_accepts_typed_lands():
    # Regression: typed lands (shocks/duals/manlands) must count as lands.
    assert lands.is_land({"type_line": "Land — Plains Island"})   # shock land
    assert lands.is_land({"type_line": "Land"})
    assert lands.is_land({"type_line": "Legendary Land"})
    assert lands.is_land({"type_line": "Basic Land — Forest"})
    assert lands.is_land({"type_line": "Land Creature — Elemental"})
    assert not lands.is_land({"type_line": "Creature — Elf"})
    assert not lands.is_land({"type_line": "Enchantment — Aura"})
    # A transform DFC's land is on the BACK — you cast the front and only reach the
    # land by transforming, so it is not a manabase land (e.g. Ixalan god // Temple).
    assert not lands.is_land({"type_line": "Artifact // Land — Cave", "layout": "transform"})
    assert not lands.is_land({"type_line": "Enchantment // Land", "layout": "transform"})
    assert not lands.is_land({"type_line": "Legendary Creature — God // Land", "layout": "transform"})
    # A modal DFC lets you play either face, so a land on EITHER face counts
    # (Zendikar Rising "Spell // Land" MDFCs and pathways).
    assert lands.is_land({"type_line": "Sorcery — Arcane // Land — Mountain", "layout": "modal_dfc"})
    assert lands.is_land({"type_line": "Land // Land", "layout": "modal_dfc"})
    # A land with a spell on its back (adventure "Town" lands) IS a land.
    assert lands.is_land({"type_line": "Land — Town // Sorcery — Adventure", "layout": "adventure"})


# --------------------------------------------------------------------------
# build-data land color parsing: granted vs. own mana abilities
# --------------------------------------------------------------------------
def test_land_ignores_granted_mana_abilities():
    """A land doesn't make mana through abilities it GRANTS to other permanents.
    Forgotten Monument taps only for {C}; its 'any color' is granted (in quotes)
    to other Caves, so Scryfall's produced_mana over-reports all five colors."""
    granted = {
        "name": "Forgotten Monument", "type_line": "Land — Cave",
        "produced_mana": ["B", "C", "G", "R", "U", "W"],
        "oracle_text": ('{T}: Add {C}.\nOther Caves you control have '
                        '"{T}, Pay 1 life: Add one mana of any color."'),
    }
    assert build_data.slim_land(granted)["colors"] == []

    # A land's OWN any-color ability (same wording, not granted) is real fixing.
    own = {
        "name": "Starting Town", "type_line": "Land — Town",
        "produced_mana": ["B", "C", "G", "R", "U", "W"],
        "oracle_text": ("{T}: Add {C}.\n{T}, Pay 1 life: Add one mana of any color."),
    }
    assert build_data.slim_land(own)["colors"] == ["B", "G", "R", "U", "W"]


def test_land_basic_check_land_gates_color_on_a_basic():
    """Marvel 'check lands' tap for {C} freely but make their colors only with a
    basic in play, so their colored output is gated on controlling an actual
    basic land (not merely a basic land type, which typed nonbasic duals share)."""
    bastion = {
        "name": "Gleaming Bastion", "type_line": "Land",
        "produced_mana": ["C", "U", "W"],
        "oracle_text": ("{T}: Add {C}.\n{T}: Add {W} or {U}. Activate only if this "
                        "land entered this turn or if you control a basic land."),
    }
    out = build_data.slim_land(bastion)
    assert out["colors"] == ["U", "W"]        # optimistic dual for the closed-form grade
    assert out["gatedColors"] == ["U", "W"]   # ...but both colors are gated
    assert out.get("needsBasic") is True
    assert "typeGate" not in out              # gated on a basic, not a basic land type


def test_unrecognized_activation_gate_is_conservative():
    """An 'Activate only if ...' gate that names neither a basic land nor a basic
    land type can't be evaluated, so its colors must NOT ship as unconditional
    fixing (previously they fell through into plain `colors`). They land in the
    flagged `unknownGated` field instead, and the land counts as colorless."""
    weird = {
        "name": "Gated Ruins", "type_line": "Land",
        "produced_mana": ["B", "R"],
        "oracle_text": ("{T}: Add {C}.\n{T}: Add {B} or {R}. Activate only if "
                        "you control a Gate."),
    }
    out = build_data.slim_land(weird)
    assert out["colors"] == []                     # not credited as reliable fixing
    assert out.get("unknownGated") == ["B", "R"]   # flagged, not silently dropped
    assert "gatedColors" not in out and "typeGate" not in out

    # A recognized basic-TYPE gate (the Verge cycle) keeps its normal handling.
    verge = {
        "name": "Gloomlake Verge", "type_line": "Land",
        "produced_mana": ["B", "U"],
        "oracle_text": ("{T}: Add {U}.\n{T}: Add {B}. Activate only if you "
                        "control an Island or a Swamp."),
    }
    v = build_data.slim_land(verge)
    assert v["colors"] == ["B", "U"] and v["gatedColors"] == ["B"]
    assert v["typeGate"] == ["Island", "Swamp"]
    assert "unknownGated" not in v


def test_life_condition_land_reads_as_tapped():
    """A land that enters tapped 'unless a player has 13 or less life' (the
    Duskmourn cycle) is effectively tapped while you're curving out — nobody is at
    low life yet — so it should not be treated as an untapped source."""
    assert build_data._enters_tapped(
        "this land enters tapped unless a player has 13 or less life.\n{t}: add {w} or {u}.") is True
    # ...but a turn-based "unless" (Starting Town) really is untapped early.
    assert build_data._enters_tapped(
        "this land enters tapped unless it's your first, second, or third turn of the game.") is False


def test_slow_land_is_flagged_untapped_but_slow():
    """Slow lands ('enters tapped unless you control two or more other lands') are
    kept untapped (they're untapped from turn 3, when their decks cast), but flagged
    `slow` so the simulator can treat them as tapped on turns 1-2."""
    out = build_data.slim_land({
        "name": "Sundown Pass", "type_line": "Land", "produced_mana": ["R", "W"],
        "oracle_text": ("This land enters tapped unless you control two or more other "
                        "lands.\n{T}: Add {R} or {W}."),
    })
    assert out["tapped"] is False
    assert out.get("slow") is True


def test_roads_land_defaults_tapped_with_untap_condition():
    """The 'Roads' cycle ('enters tapped unless you control a Mount or Vehicle') banks
    on a board state most decks never reach, so it defaults to tapped with an
    `untapWhen` flag the app uses to untap it only for Mount/Vehicle decks."""
    road = build_data.slim_land({
        "name": "Rocky Roads", "type_line": "Land", "produced_mana": ["R"],
        "oracle_text": "This land enters tapped unless you control a Mount or Vehicle.\n{T}: Add {R}.",
    })
    assert road["tapped"] is True and road.get("untapWhen") == "mount or vehicle" and road["colors"] == ["R"]


def test_basic_unless_land_defaults_tapped():
    """The 'enters tapped unless you control a basic land [type]' cycle (Avatar's
    village/temple/palace lands) banks on running basics the recommender can't promise,
    so it defaults to TAPPED with an `untapBasic` flag the simulator uses to untap it
    in games where a basic is actually in play. Both the 'a basic land' and the
    specific basic-type ('Island or a Plains') wordings are covered. The colors stay
    reliable — only the tapped status is conditional."""
    any_basic = build_data.slim_land({
        "name": "Agna Qel'a", "type_line": "Land", "produced_mana": ["U"],
        "oracle_text": "This land enters tapped unless you control a basic land.\n{T}: Add {U}.",
    })
    assert any_basic["tapped"] is True and any_basic.get("untapBasic") is True and any_basic["colors"] == ["U"]

    by_type = build_data.slim_land({
        "name": "Cori Mountain Monastery", "type_line": "Land", "produced_mana": ["R"],
        "oracle_text": "This land enters tapped unless you control an Island or a Plains.\n{T}: Add {R}.",
    })
    assert by_type["tapped"] is True and by_type.get("untapBasic") is True and by_type["colors"] == ["R"]

    # Regression: slow ("two or more other lands") and life conditions must NOT be
    # mistaken for the basic cycle — they keep their own handling.
    slow = build_data.slim_land({
        "name": "Sundown Pass", "type_line": "Land", "produced_mana": ["R", "W"],
        "oracle_text": "This land enters tapped unless you control two or more other lands.\n{T}: Add {R} or {W}.",
    })
    assert slow["tapped"] is False and slow.get("slow") is True and "untapBasic" not in slow


def test_smooths_ignores_board_triggered_card_selection():
    """A card only counts as cheap draw/ramp (smooth) when the dig comes from casting
    it — a cantrip, an ETB, or an always-on/activated ability — not from a board state
    you have to earn. A draw gated behind attacking, tapping, or dealing combat damage
    is not reliable early smoothing (Gran-Gran loots only when it becomes tapped)."""
    s = build_data._smooths

    # The reported case: tap-triggered loot on a 1-drop creature -> NOT smooth.
    assert s({"cmc": 1, "type_line": "Legendary Creature — Human", "oracle_text":
              "Whenever Gran-Gran becomes tapped, draw a card, then discard a card."}) is False
    # Other board-gated draws are out too.
    assert s({"cmc": 2, "type_line": "Creature — Human", "oracle_text":
              "Whenever this creature attacks, draw a card."}) is False
    assert s({"cmc": 2, "type_line": "Creature", "oracle_text":
              "When this creature dies, draw a card."}) is False

    # Real smoothing stays smooth: a cantrip, an ETB draw, and an ETB-or-leaves draw
    # (drawing on enter is cast-time smoothing even though it also triggers on leaving).
    assert s({"cmc": 1, "type_line": "Instant", "oracle_text": "Draw a card."}) is True
    assert s({"cmc": 2, "type_line": "Creature", "oracle_text":
              "When this creature enters, draw a card."}) is True
    assert s({"cmc": 2, "type_line": "Artifact", "oracle_text":
              "When this artifact enters or leaves the battlefield, draw a card."}) is True
    # A literal "{T}:" activated ability that draws/loots IS on-demand smoothing (you
    # tap it on your own terms) — unlike Gran-Gran's *triggered* "becomes tapped".
    assert s({"cmc": 2, "type_line": "Creature", "oracle_text": "{T}: Draw a card."}) is True
    assert s({"cmc": 2, "type_line": "Creature", "oracle_text":
              "{1}, {T}: Draw a card, then discard a card."}) is True

    # Ramp / land fetch unaffected.
    assert s({"cmc": 1, "type_line": "Creature — Elf Druid", "produced_mana": ["G"],
              "oracle_text": "{T}: Add {G}."}) is True


def test_smooths_excludes_lands():
    """A LAND is never a smoother — it can't trim the land count it is part of.
    Fetch-lands (Evolving Wilds) match the 'search your library for a land'
    wording but are modeled on the land side (`slim_land`'s fetch flag), so the
    search branch must exclude lands the way the produced_mana branch does."""
    wilds = {"cmc": 0, "type_line": "Land", "name": "Evolving Wilds",
             "oracle_text": ("{T}, Sacrifice this land: Search your library for a "
                             "basic land card, put it onto the battlefield tapped, "
                             "then shuffle.")}
    assert build_data._smooths(wilds) is False
    assert build_data.slim_card(wilds)["smooth"] is False
    # The nonland equivalent wording still smooths.
    assert build_data._smooths({"cmc": 2, "type_line": "Sorcery", "oracle_text":
                                "Search your library for a basic land card…"}) is True


def test_fetch_flag_distinguishes_land_search_from_cantrips():
    """`fetch` marks a low-cost nonland that searches for a *land* (the sim resolves
    it to a chosen color), distinct from generic card draw (still `smooth`)."""
    cultivate = {"cmc": 3, "type_line": "Sorcery", "name": "Cultivate", "oracle_text":
                 "Search your library for up to two basic land cards…"}
    assert build_data._fetches_land(cultivate) is True
    assert build_data._smooths(cultivate) is True            # a fetch is still a smoother
    assert build_data.slim_card(cultivate)["fetch"] is True

    cantrip = {"cmc": 1, "type_line": "Instant", "name": "Opt",
               "oracle_text": "Scry 1. Draw a card."}
    assert build_data._fetches_land(cantrip) is False
    assert build_data.slim_card(cantrip)["fetch"] is False
    assert build_data.slim_card(cantrip)["smooth"] is True

    # Fetch *lands* (Evolving Wilds) are handled on the land side, not here.
    assert build_data._fetches_land({"cmc": 0, "type_line": "Land", "name": "Evolving Wilds",
                                     "oracle_text": "Search your library for a basic land card…"}) is False


# --------------------------------------------------------------------------
# build-data output validation (the floors that gate the weekly commit)
# --------------------------------------------------------------------------
def _plausible_snapshot(n_lands=250, n_cards=3500):
    lands_out = [build_data.slim_land(_land("Land {}".format(i), ["W"],
                                            oracle_text="{T}: Add {W}."))
                 for i in range(n_lands)]
    cards_out = {}
    for i in range(n_cards):
        name = "Card {}".format(i)
        cards_out[name.lower()] = build_data.slim_card(
            {"name": name, "mana_cost": "{1}{W}", "type_line": "Creature",
             "oracle_text": ""})
    return lands_out, cards_out


def test_validate_data_accepts_plausible_snapshot():
    lands_out, cards_out = _plausible_snapshot()
    build_data.validate_data(lands_out, cards_out)  # must not raise


def test_validate_data_trips_on_too_few_lands():
    lands_out, cards_out = _plausible_snapshot(n_lands=50)
    with pytest.raises(SystemExit, match="lands"):
        build_data.validate_data(lands_out, cards_out)


def test_validate_data_trips_on_too_few_cards():
    lands_out, cards_out = _plausible_snapshot(n_cards=100)
    with pytest.raises(SystemExit, match="cards"):
        build_data.validate_data(lands_out, cards_out)


def test_validate_data_trips_on_colorless_land_pool():
    # A pool where (nearly) every land parsed to no mana identity at all
    # means the color analysis broke — the floor must trip.
    lands_out, cards_out = _plausible_snapshot()
    for land in lands_out:
        land["colors"] = []
        for key in ("fetch", "condColors", "gatedColors"):
            land.pop(key, None)
    with pytest.raises(SystemExit, match="mana identity"):
        build_data.validate_data(lands_out, cards_out)


def test_validate_data_tolerates_utility_and_conditional_lands():
    # ~15% pure-colorless utility lands plus conditional lands whose colors
    # live in condColors are a normal pool shape, not a parsing failure.
    lands_out, cards_out = _plausible_snapshot()
    for land in lands_out[:40]:            # utility: no identity at all
        land["colors"] = []
    for land in lands_out[40:60]:          # conditional: identity via condColors
        land["colors"] = []
        land["condColors"] = ["W", "U", "B", "R", "G"]
    build_data.validate_data(lands_out, cards_out)  # must not raise


def test_validate_data_trips_on_missing_keys():
    lands_out, cards_out = _plausible_snapshot()
    del lands_out[0]["tapped"]
    with pytest.raises(SystemExit, match="missing keys"):
        build_data.validate_data(lands_out, cards_out)

    lands_out, cards_out = _plausible_snapshot()
    del next(iter(cards_out.values()))["smooth"]
    with pytest.raises(SystemExit, match="missing keys"):
        build_data.validate_data(lands_out, cards_out)
