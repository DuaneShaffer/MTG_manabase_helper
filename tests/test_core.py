"""Tests for the pure-logic core (parser, requirements, lands, dedup).

Run with:  python -m pytest        (from the repo root)

These use small inline fixtures rather than the multi-MB Scryfall dumps, except
for one slower end-to-end test that loads the real Standard data if present.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core import carddb, decklist, hypergeometric, lands, recommend, requirements
from core.util import list_of_seq_unique_by_key

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "example_deck_cards.json")


# --------------------------------------------------------------------------
# util
# --------------------------------------------------------------------------
def test_unique_by_key_keeps_first():
    seq = [{"n": "a", "v": 1}, {"n": "b", "v": 2}, {"n": "a", "v": 3}]
    out = list_of_seq_unique_by_key(seq, "n")
    assert [x["v"] for x in out] == [1, 2]


# --------------------------------------------------------------------------
# decklist parser (#3)
# --------------------------------------------------------------------------
SAMPLE_DECK = """Deck
1 Island (THB) 251
4 Adarkar Wastes (DMU) 243
2 Teferi, Who Slows the Sunset (MID) 245

Sideboard
1 Negate (RIX) 44
"""


def test_parse_quantities_and_multiword_names():
    entries = decklist.parse_decklist_text(SAMPLE_DECK)
    teferi = [e for e in entries if e.name == "Teferi, Who Slows the Sunset"]
    assert len(teferi) == 1
    assert teferi[0].qty == 2
    assert teferi[0].set == "MID"
    assert teferi[0].collector == "245"


def test_parse_sections():
    entries = decklist.parse_decklist_text(SAMPLE_DECK)
    assert {e.name for e in decklist.deck_entries(entries, "deck")} == {
        "Island", "Adarkar Wastes", "Teferi, Who Slows the Sunset",
    }
    assert [e.name for e in decklist.deck_entries(entries, "sideboard")] == ["Negate"]


def test_parse_skips_headers_and_blanks():
    # "Deck"/"Sideboard"/blank lines must not become cards.
    names = [e.name for e in decklist.parse_decklist_text(SAMPLE_DECK)]
    assert "Deck" not in names and "" not in names


def test_parse_bare_quantity_name():
    entries = decklist.parse_decklist_text("3 Llanowar Elves")
    assert entries[0].qty == 3 and entries[0].name == "Llanowar Elves"
    assert entries[0].set is None


def test_card_names_dedupes_preserving_order():
    entries = decklist.parse_decklist_text("1 A (X) 1\n1 B (X) 2\n1 A (X) 3")
    assert decklist.card_names(entries) == ["A", "B"]


# --------------------------------------------------------------------------
# requirements (#4)
# --------------------------------------------------------------------------
def test_karsten_shape_mono():
    # {1}{W}{W} -> white needs the '1CC' slot (18), not gold.
    shape, gold = requirements.karsten_shape("{1}{W}{W}", "W")
    assert shape == "1CC" and gold is False
    assert requirements.FRANK_RECOMMENDATION["1CC"] == 18


def test_karsten_shape_gold_adds_pressure():
    # {1}{W}{U} for white: the U pip counts as generic and marks it gold.
    shape, gold = requirements.karsten_shape("{1}{W}{U}", "W")
    assert shape == "2C" and gold is True


def test_requirements_gold_plus_one():
    reqs = requirements.requirements_for_costs(["{1}{W}{U}"])
    # '2C' base is 12; gold adds +1 for each color.
    assert reqs["W"] == 13 and reqs["U"] == 13
    assert reqs["B"] == 0


def test_requirements_takes_max_across_cards():
    reqs = requirements.requirements_for_costs(["{W}", "{W}{W}{W}"])
    # 'C'=14, 'CCC'=23 -> max is 23.
    assert reqs["W"] == 23


def test_requirements_ignores_empty_and_colorless():
    reqs = requirements.requirements_for_costs(["", "{3}", "{C}"])
    assert all(v == 0 for v in reqs.values())


# --- token parser fixes (vs the old char-by-char parser) ------------------
def test_parse_multi_digit_generic():
    # {10}{W} -> generic 10, one white pip. Old parser read "10" as 1+0=1.
    generic, colored = requirements.parse_cost("{10}{W}")
    assert generic == 10 and colored["W"] == 1
    assert requirements.karsten_shape("{10}{W}", "W") == ("10C", False)


def test_colorless_pip_is_not_gold():
    # {C}{W} for white: the colorless pip is generic pressure, not multicolor.
    shape, gold = requirements.karsten_shape("{C}{W}", "W")
    assert shape == "1C" and gold is False


def test_hybrid_pip_treated_as_generic():
    # Hybrid {W/U} forces no single color, so it adds no colored requirement.
    assert requirements.colors_in_cost("{W/U}") == set()
    generic, colored = requirements.parse_cost("{1}{W/U}")
    assert generic == 2 and all(v == 0 for v in colored.values())


def test_variable_x_is_zero():
    generic, _ = requirements.parse_cost("{X}{X}{R}")
    assert generic == 0


# --------------------------------------------------------------------------
# lands (#5, #2)
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


# --------------------------------------------------------------------------
# carddb (#3/#4 bridge)
# --------------------------------------------------------------------------
def test_cards_by_names_prefers_latest_printing():
    data = [
        {"name": "Shock", "released_at": "2017-01-01", "v": "old"},
        {"name": "Shock", "released_at": "2022-01-01", "v": "new"},
        {"name": "Other", "released_at": "2020-01-01", "v": "x"},
    ]
    out = carddb.cards_by_names(data, ["Shock"])
    assert len(out) == 1 and out[0]["v"] == "new"


# --------------------------------------------------------------------------
# hypergeometric engine (live source-count model)
# --------------------------------------------------------------------------
def test_hypergeometric_reproduces_karsten_table():
    # 13 of 14 canonical 60-card cells match exactly; the turn-1 single pip is
    # the one documented soft spot, so we allow ±2 only there.
    cells = [
        (1, 1, "C"), (1, 2, "1C"), (1, 3, "2C"), (2, 2, "CC"), (2, 3, "1CC"),
        (2, 4, "2CC"), (3, 3, "CCC"), (3, 4, "1CCC"), (4, 4, "CCCC"),
    ]
    for pips, mv, key in cells:
        calc = hypergeometric.sources_needed(pips, mv)
        table = requirements.FRANK_RECOMMENDATION[key]
        tolerance = 2 if key == "C" else 0
        assert abs(calc - table) <= tolerance, (key, calc, table)


def test_sliding_threshold():
    assert hypergeometric.threshold_for(1) == 0.90
    assert hypergeometric.threshold_for(3) == 0.92
    assert hypergeometric.threshold_for(20) == hypergeometric.THRESHOLD_CAP  # clamped


def test_flat_threshold_needs_more_sources():
    sliding = hypergeometric.sources_needed(2, 3)               # ~0.92 target
    flat95 = hypergeometric.sources_needed(2, 3, threshold=0.95)
    assert flat95 > sliding


def test_smaller_deck_needs_fewer_sources():
    assert hypergeometric.sources_needed(1, 1, deck_size=40) < hypergeometric.sources_needed(1, 1, deck_size=60)


def test_castable_probability_monotonic_and_graded():
    p_low = hypergeometric.castable_probability(2, 3, sources=10)
    p_high = hypergeometric.castable_probability(2, 3, sources=18)
    assert 0 <= p_low < p_high <= 1
    assert hypergeometric.grade(0.97)[0] == "A"
    assert hypergeometric.grade(0.5)[0] == "F"
    assert hypergeometric.castable_probability(0, 3, sources=0) == 1.0  # no pips → trivially castable


def test_engine_is_cached():
    hypergeometric.sources_needed.cache_clear()
    hypergeometric.sources_needed(2, 3)
    hypergeometric.sources_needed(2, 3)
    info = hypergeometric.sources_needed.cache_info()
    assert info.hits >= 1


# --------------------------------------------------------------------------
# recommender (#9)
# --------------------------------------------------------------------------
def test_recommender_meets_requirements_with_basics():
    plains = {"name": "Plains", "produced_mana": ["W"], "type_line": "Basic Land — Plains"}
    island = {"name": "Island", "produced_mana": ["U"], "type_line": "Basic Land — Island"}
    rec = recommend.recommend({"W": 10, "U": 6, "B": 0, "R": 0, "G": 0}, [plains, island])
    assert rec["met"]["W"] and rec["met"]["U"]
    assert rec["shortfall"] == {}
    assert rec["sources"]["W"] >= 10 and rec["sources"]["U"] >= 6


def test_recommender_prefers_duals_over_basics():
    plains = {"name": "Plains", "produced_mana": ["W"], "type_line": "Basic Land — Plains"}
    island = {"name": "Island", "produced_mana": ["U"], "type_line": "Basic Land — Island"}
    dual = {"name": "WU Dual", "produced_mana": ["W", "U"], "type_line": "Land"}
    rec = recommend.recommend({"W": 4, "U": 4, "B": 0, "R": 0, "G": 0},
                              [plains, island, dual])
    # The dual covers both deficits at once, so it should be chosen (capped at 4).
    assert rec["counts"].get("WU Dual", 0) == 4
    # ...and with 4 duals giving 4 W + 4 U, no basics are needed.
    assert rec["total"] == 4


def test_recommender_prefers_focused_dual_over_rainbow():
    # A 2-color deck should pick the W/U dual, not a 5-color land that wastes
    # three off-colors, even though both "cover" W and U.
    dual = {"name": "WU Dual", "produced_mana": ["W", "U"], "type_line": "Land"}
    rainbow = {"name": "Rainbow", "produced_mana": ["W", "U", "B", "R", "G"], "type_line": "Land"}
    rec = recommend.recommend({"W": 4, "U": 4, "B": 0, "R": 0, "G": 0}, [rainbow, dual])
    assert rec["counts"].get("WU Dual", 0) == 4
    assert "Rainbow" not in rec["counts"]


def test_recommender_is_deterministic_regardless_of_order():
    a = {"name": "Aaa Dual", "produced_mana": ["W", "U"], "type_line": "Land"}
    z = {"name": "Zzz Dual", "produced_mana": ["W", "U"], "type_line": "Land"}
    req = {"W": 4, "U": 4, "B": 0, "R": 0, "G": 0}
    assert recommend.recommend(req, [a, z])["counts"] == recommend.recommend(req, [z, a])["counts"]


def test_recommender_reports_shortfall_under_cap():
    plains = {"name": "Plains", "produced_mana": ["W"], "type_line": "Basic Land — Plains"}
    rec = recommend.recommend({"W": 10, "U": 0, "B": 0, "R": 0, "G": 0},
                              [plains], max_lands=3)
    assert rec["total"] == 3
    assert rec["shortfall"].get("W") == 7


def test_recommender_counts_only_positive():
    # Regression: probing the per-card cap must not leave 0-count entries.
    pool = [
        {"name": "Plains", "produced_mana": ["W"], "type_line": "Basic Land — Plains"},
        {"name": "Unused Dual", "produced_mana": ["B", "G"], "type_line": "Land"},
    ]
    rec = recommend.recommend({"W": 5, "U": 0, "B": 0, "R": 0, "G": 0}, pool)
    assert all(v > 0 for v in rec["counts"].values())
    assert "Unused Dual" not in rec["counts"]
    assert sum(rec["counts"].values()) == rec["total"]


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
# end-to-end regression against a committed fixture (offline, deterministic)
# --------------------------------------------------------------------------
def test_example_deck_requirements_regression():
    with open(FIXTURE) as fh:
        cards = json.load(fh)
    reqs = requirements.requirements_for_cards(cards)
    # Golden values for the bundled example deck.
    assert reqs == {"W": 16, "U": 13, "B": 0, "R": 18, "G": 0}


# --------------------------------------------------------------------------
# build-data land color parsing: granted vs. own mana abilities
# --------------------------------------------------------------------------
def test_land_ignores_granted_mana_abilities():
    """A land doesn't make mana through abilities it GRANTS to other permanents.
    Forgotten Monument taps only for {C}; its 'any color' is granted (in quotes)
    to other Caves, so Scryfall's produced_mana over-reports all five colors."""
    sys.path.insert(0, os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
    import build_data

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
    sys.path.insert(0, os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
    import build_data

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


def test_life_condition_land_reads_as_tapped():
    """A land that enters tapped 'unless a player has 13 or less life' (the
    Duskmourn cycle) is effectively tapped while you're curving out — nobody is at
    low life yet — so it should not be treated as an untapped source."""
    sys.path.insert(0, os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
    import build_data
    assert build_data._enters_tapped(
        "this land enters tapped unless a player has 13 or less life.\n{t}: add {w} or {u}.") is True
    # ...but a turn-based "unless" (Starting Town) really is untapped early.
    assert build_data._enters_tapped(
        "this land enters tapped unless it's your first, second, or third turn of the game.") is False


def test_slow_land_is_flagged_untapped_but_slow():
    """Slow lands ('enters tapped unless you control two or more other lands') are
    kept untapped (they're untapped from turn 3, when their decks cast), but flagged
    `slow` so the simulator can treat them as tapped on turns 1-2."""
    sys.path.insert(0, os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
    import build_data
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
    `untapWhen` flag the app uses to untap it only for Mount/Vehicle decks. The
    3-color check-land cycle (off-color basic-type checks) is NOT touched — those decks
    run the enabling basics, so they stay untapped."""
    sys.path.insert(0, os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
    import build_data
    road = build_data.slim_land({
        "name": "Rocky Roads", "type_line": "Land", "produced_mana": ["R"],
        "oracle_text": "This land enters tapped unless you control a Mount or Vehicle.\n{T}: Add {R}.",
    })
    assert road["tapped"] is True and road.get("untapWhen") == "mount or vehicle" and road["colors"] == ["R"]

    check = build_data.slim_land({
        "name": "Cori Mountain Monastery", "type_line": "Land", "produced_mana": ["R"],
        "oracle_text": "This land enters tapped unless you control an Island or a Plains.\n{T}: Add {R}.",
    })
    assert check["tapped"] is False and "untapWhen" not in check
