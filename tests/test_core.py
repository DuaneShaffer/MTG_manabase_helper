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
# modal double-faced cards: pathways (land//land) and spell//land MDFCs
# --------------------------------------------------------------------------
def _pathway():
    """A Branchloft Pathway-shaped modal DFC: both faces are lands, root
    mana_cost/oracle_text absent (everything lives on the faces), and Scryfall's
    card-wide produced_mana conflates the two faces."""
    return {
        "name": "Branchloft Pathway // Boulderloft Pathway",
        "layout": "modal_dfc", "type_line": "Land // Land",
        "produced_mana": ["G", "W"], "rarity": "rare",
        "card_faces": [
            {"name": "Branchloft Pathway", "type_line": "Land",
             "mana_cost": "", "oracle_text": "{T}: Add {G}.",
             "image_uris": {"small": "s1", "normal": "n1"}},
            {"name": "Boulderloft Pathway", "type_line": "Land",
             "mana_cost": "", "oracle_text": "{T}: Add {W}.",
             "image_uris": {"small": "s2", "normal": "n2"}},
        ],
    }


def _spell_land_mdfc():
    """A Bala Ged Recovery-shaped modal DFC: nonland spell front, land back."""
    return {
        "name": "Bala Ged Recovery // Bala Ged Sanctuary",
        "layout": "modal_dfc", "type_line": "Sorcery // Land",
        "cmc": 3, "produced_mana": ["G"], "rarity": "uncommon",
        "card_faces": [
            {"name": "Bala Ged Recovery", "type_line": "Sorcery",
             "mana_cost": "{2}{G}",
             "oracle_text": "Return target card from your graveyard to your hand.",
             "image_uris": {"small": "front-small", "normal": "front-normal"}},
            {"name": "Bala Ged Sanctuary", "type_line": "Land",
             "mana_cost": "",
             "oracle_text": "This land enters tapped.\n{T}: Add {G}.",
             "image_uris": {"small": "back-small", "normal": "back-normal"}},
        ],
    }


def test_pathway_land_land_mdfc_is_pick_one_with_faces():
    """A land//land modal DFC (Pathway) is NOT a free dual — you play one face
    and are locked in. It ships pickOne + a per-face color/tapped breakdown,
    while the top-level colors stay the union so existing consumers work."""
    out = build_data.slim_land(_pathway())
    assert out["pickOne"] is True
    assert out["faces"] == [
        {"name": "Branchloft Pathway", "colors": ["G"], "tapped": False},
        {"name": "Boulderloft Pathway", "colors": ["W"], "tapped": False},
    ]
    assert out["colors"] == ["G", "W"]      # union, for existing consumers
    assert out["tapped"] is False           # every face can come down untapped

    # A pathway with one tapped face is still untapped at top level (you would
    # pick the untapped face), but the per-face data tells the truth.
    slow = _pathway()
    slow["card_faces"][1]["oracle_text"] = "This land enters tapped.\n{T}: Add {W}."
    s = build_data.slim_land(slow)
    assert s["tapped"] is False
    assert s["faces"][1]["tapped"] is True

    # An ordinary single-faced dual gets no pickOne/faces fields.
    dual = build_data.slim_land(_land("Plain Dual", ["G", "W"],
                                      oracle_text="{T}: Add {G} or {W}."))
    assert "pickOne" not in dual and "faces" not in dual


def test_pathway_faces_analyzed_with_land_rules():
    """Per-face analysis reuses the land parsing: a basic-typed face credits its
    type's color, and an any-color face credits all five."""
    card = _pathway()
    card["card_faces"][0].update(type_line="Land — Forest", oracle_text="")
    card["card_faces"][1].update(
        oracle_text="{T}: Add one mana of any color.")
    card["produced_mana"] = ["B", "G", "R", "U", "W"]
    out = build_data.slim_land(card)
    assert out["faces"][0]["colors"] == ["G"]
    assert out["faces"][1]["colors"] == ["B", "G", "R", "U", "W"]


def test_spell_land_mdfc_is_a_spell_with_backland():
    """A spell//land modal DFC ships in cards.json as its FRONT-face spell —
    front cost and image, smooth/fetch judged on the front face only — plus a
    `backLand` describing the land mode (colors via per-face analysis)."""
    out = build_data.slim_card(_spell_land_mdfc())
    assert out["cost"] == "{2}{G}"                 # front face, not joined
    assert out["image"] == "front-small"           # front face image
    assert out["backLand"] == {"colors": ["G"], "tapped": True}
    assert out["smooth"] is False and out["fetch"] is False

    # The land face's text must not make the card look like a smoother: even a
    # scry rider on the LAND face is unavailable when cast as the spell.
    scry_back = _spell_land_mdfc()
    scry_back["card_faces"][1]["oracle_text"] = (
        "This land enters tapped.\nWhen this land enters, scry 1.\n{T}: Add {G}.")
    assert build_data.slim_card(scry_back)["smooth"] is False

    # ...while a draw spell on the FRONT face still counts as smoothing.
    cantrip_front = _spell_land_mdfc()
    cantrip_front["card_faces"][0]["oracle_text"] = "Draw two cards."
    assert build_data.slim_card(cantrip_front)["smooth"] is True


def test_spell_land_mdfc_is_excluded_from_the_land_pool():
    """`is_land` accepts a land on either modal face, so the land search
    matches spell//land MDFCs — but they ship as cards (with backLand), and
    `_back_land_face` is the gate main() uses to keep them out of lands.json.
    A pathway (land front) and an adventure-town land must stay lands."""
    assert build_data._back_land_face(_spell_land_mdfc()) is not None
    assert build_data._back_land_face(_pathway()) is None
    town = {"name": "Ishgard, the Holy See // Faith & Grief", "layout": "adventure",
            "type_line": "Land — Town // Sorcery — Adventure",
            "card_faces": [
                {"name": "Ishgard, the Holy See", "type_line": "Land — Town",
                 "oracle_text": "This land enters tapped.\n{T}: Add {W}."},
                {"name": "Faith & Grief", "type_line": "Sorcery — Adventure",
                 "mana_cost": "{3}{W}{W}", "oracle_text": ""}]}
    assert build_data._back_land_face(town) is None
    # A transform card with a back-face land is not a modal DFC at all.
    god = {"name": "God // Temple", "layout": "transform",
           "type_line": "Legendary Creature — God // Land",
           "card_faces": [{"name": "God", "type_line": "Legendary Creature — God"},
                          {"name": "Temple", "type_line": "Land"}]}
    assert build_data._back_land_face(god) is None


# --------------------------------------------------------------------------
# nonland mana producers (dorks / rocks)
# --------------------------------------------------------------------------
def test_mana_producer_flags_dorks_and_rocks():
    """A nonland permanent with a repeatable '{T}: Add <colored>' ability is a
    fractional mana source: creatures flag as dorks, artifacts/enchantments as
    rocks, and the activation cost may include mana on top of the tap."""
    elves = build_data.slim_card({
        "name": "Llanowar Elves", "mana_cost": "{G}",
        "type_line": "Creature — Elf Druid", "cmc": 1, "produced_mana": ["G"],
        "oracle_text": "{T}: Add {G}."})
    assert elves["manaColors"] == ["G"] and elves["manaKind"] == "dork"
    assert elves["smooth"] is True          # still a smoother — flags coexist

    signet = build_data.slim_card({
        "name": "Azorius Signet", "mana_cost": "{2}", "type_line": "Artifact",
        "cmc": 2, "produced_mana": ["U", "W"],
        "oracle_text": "{1}, {T}: Add {W}{U}."})
    assert signet["manaColors"] == ["U", "W"] and signet["manaKind"] == "rock"

    shrine = build_data.slim_card({
        "name": "Mana Shrine", "mana_cost": "{2}", "type_line": "Enchantment",
        "cmc": 2, "produced_mana": ["B", "G", "R", "U", "W"],
        "oracle_text": "{T}: Add one mana of any color."})
    assert shrine["manaColors"] == ["B", "G", "R", "U", "W"]
    assert shrine["manaKind"] == "rock"     # noncreature permanent -> rock

    # Colored mana in the COST must not leak into the produced colors.
    filt = build_data._mana_producer({
        "name": "Filter", "type_line": "Creature — Shaman",
        "oracle_text": "{G}, {T}: Add {W}{W}."})
    assert filt == (["W"], "dork")


def test_mana_producer_excludes_one_shots_colorless_and_lands():
    p = build_data._mana_producer
    # Ritual: no {T} ability — a one-shot, not a source.
    assert p({"name": "Ritual", "type_line": "Sorcery",
              "oracle_text": "Add {R}{R}{R}."}) == (None, None)
    # Sacrifice cost: one-shot even with a tap (Lotus Petal-style).
    assert p({"name": "Petal", "type_line": "Artifact",
              "oracle_text": "{T}, Sacrifice this artifact: Add one mana of any color."}) == (None, None)
    # Colorless-only producer.
    assert p({"name": "Mind Stone", "type_line": "Artifact",
              "oracle_text": "{T}: Add {C}.\n{1}, {T}, Sacrifice this artifact: Draw a card."}) == (None, None)
    # Lands are handled on the land side, never flagged here.
    assert p({"name": "Forest", "type_line": "Basic Land — Forest",
              "oracle_text": "{T}: Add {G}."}) == (None, None)
    # Granted abilities (quoted) belong to other permanents.
    assert p({"name": "Rite", "type_line": "Enchantment", "oracle_text":
              'Creatures you control have "{T}: Add one mana of any color."'}) == (None, None)
    # Treasure-makers: the "Add" is in the token's reminder text, and each
    # Treasure is itself one-shot — not a repeatable source.
    assert p({"name": "Vault", "type_line": "Artifact", "oracle_text":
              ('{2}, {T}: Draw a card, then discard a card. Create a Treasure '
               'token. (It\'s an artifact with "{T}, Sacrifice this artifact: '
               'Add one mana of any color.")')}) == (None, None)
    # Restricted-use mana ("spend this mana only ...") is not general fixing.
    assert p({"name": "Foundry", "type_line": "Artifact", "oracle_text":
              "{T}: Add {W}. Spend this mana only to cast an artifact spell."}) == (None, None)
    # Nonpermanents with weird Add wordings don't qualify either.
    assert p({"name": "Combat trick", "type_line": "Instant",
              "oracle_text": "Untap target creature. Add {G}."}) == (None, None)
    # No flag fields ship on a non-producer.
    out = build_data.slim_card({"name": "Bear", "mana_cost": "{1}{G}",
                                "type_line": "Creature — Bear", "cmc": 2,
                                "oracle_text": ""})
    assert "manaColors" not in out and "manaKind" not in out


def test_validate_data_checks_new_optional_fields():
    lands_out, cards_out = _plausible_snapshot()
    lands_out[0]["pickOne"] = True
    lands_out[0]["faces"] = [{"name": "A", "colors": ["W"]}]  # missing tapped + 1 face
    with pytest.raises(SystemExit, match="pickOne"):
        build_data.validate_data(lands_out, cards_out)

    lands_out, cards_out = _plausible_snapshot()
    next(iter(cards_out.values()))["backLand"] = {"colors": ["G"]}  # no tapped
    with pytest.raises(SystemExit, match="backLand"):
        build_data.validate_data(lands_out, cards_out)

    lands_out, cards_out = _plausible_snapshot()
    next(iter(cards_out.values()))["manaKind"] = "dork"  # manaColors missing
    with pytest.raises(SystemExit, match="manaColors/manaKind"):
        build_data.validate_data(lands_out, cards_out)

    # Well-formed flags pass.
    lands_out, cards_out = _plausible_snapshot()
    lands_out[0]["pickOne"] = True
    lands_out[0]["faces"] = [{"name": "A", "colors": ["W"], "tapped": False},
                             {"name": "B", "colors": ["G"], "tapped": True}]
    first = next(iter(cards_out.values()))
    first["backLand"] = {"colors": ["G"], "tapped": True}
    first["manaColors"] = ["G"]
    first["manaKind"] = "dork"
    build_data.validate_data(lands_out, cards_out)  # must not raise


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
