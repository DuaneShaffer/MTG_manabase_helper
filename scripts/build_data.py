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
            # A life-total condition ("enters tapped unless a player has 13 or less
            # life") is essentially never met while you're curving out, so the land
            # is effectively a tapland in the turns that matter — treat it as tapped
            # despite the "unless" (the Duskmourn cycle: Abandoned Campground, etc.).
            if "unless" in sentence and "less life" in sentence:
                return True
            # "Enters tapped unless you control a basic land" / "...a Plains or an
            # Island": the untap is a board condition the recommender can't promise
            # (it doesn't know it will run the enabling basics — and tends not to), so
            # treat these as TAPPED. Otherwise they masquerade as free untapped duals
            # and the recommender prefers them over real basics. The simulator untaps
            # them per-game when a basic is actually on the battlefield (see untapBasic).
            if "unless" in sentence and ("control a basic land" in sentence
                    or re.search(r"control (?:a|an) (?:plains|island|swamp|mountain|forest)\b", sentence)):
                return True
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


def _added_colors(text, produced=frozenset("WUBRG")):
    """Colors a single "Add ..." clause produces, intersected with ``produced``.

    Choose-a-color / any-color wordings mean all five. Shared by the land
    analysis and the nonland mana-producer detection.
    """
    low = text.lower()
    if ("any color" in low or "any combination" in low
            or "any one color" in low or "chosen color" in low):
        return set("WUBRG") & set(produced)
    return {s for s in "WUBRG" if "{" + s + "}" in text} & set(produced)


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
    ``unknown_gated`` — colors behind an "Activate only if" gate we can't map to
                      a basic land or basic land type (e.g. "only if you control
                      a Gate"). Conservative: these must NOT ship as reliable
                      fixing, since we can't tell when the gate is met.

    Scryfall's ``produced_mana`` over-reports (it lists every color a land *can*
    make, however restricted/costly), so we parse the abilities instead.
    """
    low = _oracle(card).lower()
    # "Becomes any basic type" lands (e.g. Multiversal Passage): on entry they turn
    # into a basic land of a chosen type, so they fix any one color — a flexible
    # five-color source, like Starting Town / a painland.
    if "choose a basic land type" in low and "the chosen type" in low:
        return sorted("WUBRG"), [], None, [], [], False, []
    produced = set(card.get("produced_mana") or []) & set("WUBRG")
    type_line = card.get("type_line", "") or ""
    if not produced:
        return [], [], None, [], [], False, []
    if any(t in type_line for t in _BASIC_TYPES):
        return sorted(produced), [], None, [], [], False, []  # typed land — genuine fixing

    reliable, conditional, condition = set(), set(), None
    type_gated, type_gate = set(), set()
    unknown_gated = set()
    needs_basic = False
    for line in _oracle(card).split("\n"):
        low = line.lower()
        # A land never makes mana through an ability it GRANTS to OTHER permanents
        # (e.g. Forgotten Monument: 'Other Caves you control have "{T}, Pay 1 life:
        # Add one mana of any color."'). Granted abilities are written in quotes, so
        # the colors belong to the other permanents — not this land. Skip them.
        if 'have "' in low:
            continue
        if "add" not in low or ":" not in line:
            continue
        cost = line.split(":", 1)[0].lower()
        if "{t}" not in cost or _BAD_COST.search(cost):
            continue
        colors = _added_colors(line, produced)
        if not colors:
            continue
        # "Spend this mana only to cast a creature spell" / "an instant or sorcery"
        m = re.search(r"spend this mana only to cast (?:a |an )?([a-z]+(?: or [a-z]+)*)", low)
        # Gated colored ability, two flavors:
        #   Verge — "Activate only if you control an Island or a Swamp" (a basic
        #     TYPE, which typed nonbasic duals also satisfy).
        #   Check land (Marvel cycle) — "Activate only if this land entered this turn
        #     or if you control a basic land" (any actual BASIC land; the land taps
        #     for {C} otherwise). Gated on a real basic, tracked via needs_basic.
        gate = None
        if "activate" in low and "only if" in low:
            mc = re.search(r"you control (?:a |an )?(.+)", low)
            if mc:
                gate = mc.group(1)
        if m:
            conditional |= colors
            condition = condition or m.group(1).replace(" spell", "").strip()
        elif gate is not None:
            if "basic land" in gate:
                type_gated |= colors
                needs_basic = True
            else:
                matched = {t for t in _BASIC_TYPES if t.lower() in gate}
                if matched:
                    type_gated |= colors
                    type_gate |= matched
                else:
                    # An "Activate only if ..." gate we don't recognize (not a
                    # basic land / basic type). Be conservative: these colors
                    # must not fold into the reliable pool — track them apart.
                    unknown_gated |= colors
        else:
            reliable |= colors
    return (sorted(reliable), sorted(conditional - reliable), condition,
            sorted(type_gated - reliable), sorted(type_gate), needs_basic,
            sorted(unknown_gated - reliable))


# ---------------------------------------------------------------------------
# double-faced cards: per-face land analysis + modal-DFC classification
# ---------------------------------------------------------------------------
def _is_land_face(face):
    return "Land" in (face.get("type_line", "") or "").split("—")[0]


def _face_produced(face):
    """Best-effort produced_mana for ONE face (Scryfall only reports it
    card-wide, which conflates the faces): basic land types on the face's type
    line plus whatever its own "Add" abilities name."""
    colors = {c for t, c in _BASIC_TYPES.items() if t in (face.get("type_line") or "")}
    for line in (face.get("oracle_text") or "").split("\n"):
        low = line.lower()
        if "add" not in low or ":" not in line:
            continue
        colors |= _added_colors(line)
    return sorted(colors)


def analyze_land_face(face):
    """(colors, tapped) for a single land face of a double-faced card, run
    through the same ability parsing as whole lands (`analyze_land_colors`)."""
    pseudo = {
        "name": face.get("name", ""),
        "type_line": face.get("type_line", "") or "",
        "oracle_text": face.get("oracle_text", "") or "",
        "produced_mana": _face_produced(face),
    }
    reliable, _cond, _condition, gated, _gate, _needs_basic, _unknown = \
        analyze_land_colors(pseudo)
    colors = sorted(set(reliable) | set(gated))
    tapped = _enters_tapped((face.get("oracle_text") or "").lower())
    return colors, tapped


def _pick_one_land_faces(card):
    """The faces of a land//land modal DFC (the Pathway cycle), else None.

    You play ONE face and are locked in — such a card is not the untapped dual
    its joined oracle text suggests, so `slim_land` ships per-face data.
    """
    if card.get("layout") != "modal_dfc":
        return None
    faces = card.get("card_faces") or []
    if len(faces) >= 2 and all(_is_land_face(f) for f in faces):
        return faces
    return None


def _back_land_face(card):
    """For a modal DFC whose FRONT face is a nonland spell, its land back face
    (spell//land MDFCs, e.g. Zendikar Rising's); None otherwise. These cards
    are spells first: they ship in cards.json with a `backLand` describing the
    land mode, and are excluded from lands.json (the land search matches them
    because `is_land` accepts a land on either modal face)."""
    if card.get("layout") != "modal_dfc":
        return None
    faces = card.get("card_faces") or []
    if len(faces) < 2 or _is_land_face(faces[0]):
        return None
    for face in faces[1:]:
        if _is_land_face(face):
            return face
    return None


def slim_land(card):
    uris = _uris(card)
    (reliable, cond_colors, condition, gated_colors, type_gate, needs_basic,
     unknown_gated) = analyze_land_colors(card)
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
    # Marvel "check land": taps for {C} freely, but its colors only with a basic in
    # play. Treat the colors as gated on controlling an actual basic land, so the
    # recommender counts them as colorless until the build runs basics.
    if gated_colors and needs_basic:
        out["gatedColors"] = gated_colors
        out["needsBasic"] = True
    # Colors behind an activation gate we couldn't classify: ship them in a
    # flagged field, NOT in `colors` — the app treats the land as a colorless
    # source rather than crediting fixing whose condition it can't evaluate.
    unknown_only = [c for c in unknown_gated if c not in out["colors"]]
    if unknown_only:
        out["unknownGated"] = unknown_only
    # Basic-fetch lands (Fabled Passage, Escape Tunnel): sacrifice to search up a
    # basic. They fix any color you run basics for, but the fetched land enters
    # tapped, so model them as a slow (tapped) flexible source.
    low = _oracle(card).lower()
    basic_fetch = "search your library for a basic land" in low and "sacrifice" in low
    if basic_fetch and not card.get("produced_mana"):
        out["colors"] = sorted("WUBRG")
        out["tapped"] = True
        out["fetch"] = True
    elif basic_fetch:
        # Makes mana on its own (e.g. Demolition Field, Promising Vein make {C}), so
        # it's a utility land — but its payoff is sacrificing to grab a basic, which
        # is dead with no basics in the deck. Flag it so the recommender only runs it
        # alongside a basic base (see optimize.js fetch_on gate), the same way check
        # lands are gated on basics.
        out["fetchesBasic"] = True
    # Slow land ("enters tapped unless you control two or more other lands"): kept
    # untapped (it IS untapped from turn 3, when the midrange/control decks that run
    # it are casting), but flagged so the simulator can treat it as tapped on turns
    # 1–2, when you don't yet control two other lands.
    if "two or more other lands" in low:
        out["slow"] = True
    # "Roads" cycle: "enters tapped unless you control a Mount or Vehicle" — a board
    # condition most decks never meet, so default to tapped. `untapWhen` lets the app
    # untap it for decks that actually run enough Mounts/Vehicles, the same deck-aware
    # way conditional-color lands turn on.
    if "enters tapped unless you control a mount or vehicle" in low:
        out["tapped"] = True
        out["untapWhen"] = "mount or vehicle"
    # "Enters tapped unless you control a basic land [type]" cycle (Avatar's village /
    # temple / palace lands). `_enters_tapped` already defaulted these to tapped; tag
    # them so the simulator can untap them in games where a basic is on the battlefield.
    # The recommender keeps treating them as taplands — it can't promise the basics,
    # and crediting untapped-ness for a board state is exactly the optimism the sim
    # exists to catch.
    if ("enters tapped unless you control a basic land" in low
            or re.search(r"enters tapped unless you control (?:a|an) "
                         r"(?:plains|island|swamp|mountain|forest)", low)):
        out["untapBasic"] = True
    # Land//land modal DFC (the Pathway cycle): the joined oracle text reads
    # like an untapped dual, but you play ONE face and are locked in. Ship the
    # per-face breakdown (`pickOne` + `faces`) and recompute the top-level
    # colors/tapped from the faces: colors stay the union (existing consumers
    # keep working), tapped is False if any face can come down untapped (you
    # would choose that face).
    faces = _pick_one_land_faces(card)
    if faces:
        face_out = []
        for face in faces:
            colors, tapped = analyze_land_face(face)
            face_out.append({"name": face.get("name", ""),
                             "colors": colors, "tapped": tapped})
        out["pickOne"] = True
        out["faces"] = face_out
        out["colors"] = sorted(set().union(*(set(f["colors"]) for f in face_out)))
        out["tapped"] = all(f["tapped"] for f in face_out)
    return out


def _fetches_land(card):
    """True for a low-cost nonland spell that searches your library for a land.

    Distinct from generic card draw: a fetch (Cultivate, land tutors) pulls a land
    you can choose, so the simulator resolves it to the color you most need rather
    than treating it as an anonymous dig. Lands that fetch (Evolving Wilds, Fabled
    Passage) are flagged separately on the land side (`slim_land`).
    """
    if (card.get("cmc", 0) or 0) > 3:
        return False
    type_line = card.get("type_line", "") or ""
    if "Land" in type_line.split("—")[0]:
        return False  # the land-side `fetch` flag covers fetch *lands*
    oracle = _oracle(card).lower()
    return "search your library for" in oracle and "land" in oracle


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
    is_land_card = "Land" in type_line.split("—")[0]
    if not is_land_card and card.get("produced_mana"):
        return True  # mana dork / rock
    # Fetch *lands* (Evolving Wilds) are lands, not smoothers — a land can't
    # trim the land count. Their fetching is modeled on the land side
    # (`slim_land`'s `fetch` flag), so exclude lands here like the ramp branch.
    if not is_land_card and "search your library for" in oracle and "land" in oracle:
        return True  # cheap land ramp / fetch
    # Card draw / selection only smooths your early game if you get it on demand — from
    # casting the card (a cantrip or ETB), a static ability, or an activated ability you
    # choose to use (including a literal "{T}:" tap ability) — not from a board-dependent
    # trigger you have to earn first. A draw gated behind ATTACKING, BECOMING TAPPED (by
    # attacking/convoke/etc.), dealing combat damage, dying, or blocking isn't reliable
    # early smoothing (and is often a card-neutral loot), so it shouldn't trim the land
    # count. Scope the signal to its own sentence so a gated trigger doesn't disqualify a
    # real cantrip elsewhere on the card.
    #   e.g. Gran-Gran ("Whenever Gran-Gran becomes tapped, draw a card, then discard a
    #        card") is gated on tapping → NOT a smoother;
    #   but a "{T}: Draw a card" activated ability you tap on your own terms → IS one.
    SIGNALS = ("draw", "scry", "surveil", "look at the top", "into your hand")
    GATES = ("becomes tapped", "attacks", "you attack", "deals combat damage",
             "dies", "blocks")
    for sentence in re.split(r"[.\n]", oracle):
        if not any(s in sentence for s in SIGNALS):
            continue
        # An activated tap ability ("{t}:" cost) or an ETB draw is on-demand smoothing,
        # so it counts even if the sentence also mentions a gate word (e.g. "enters or
        # dies"). A triggered "becomes tapped" carries no "{t}" cost, so it stays gated.
        if "{t}" in sentence or "enters" in sentence:
            return True
        if any(g in sentence for g in GATES):          # otherwise gated behind a board trigger
            continue                                   # -> not reliable early smoothing
        return True                                    # cantrip / static / non-tap activated draw
    return False


_PERMANENT_TYPES = ("Creature", "Artifact", "Enchantment")


def _mana_producer(card):
    """(colors, kind) for a nonland permanent that is a REPEATABLE colored-mana
    source — a "{T}: Add ..." activated ability (the cost may include mana on
    top of the tap, e.g. Signets' "{1}, {T}: Add {W}{U}"). Karsten credits such
    dorks/rocks as fractional sources, so the app needs them flagged.

    Excluded: one-shot effects (rituals — no {T} in the cost; sacrifice costs),
    colorless-only producers, granted abilities (quoted text belongs to other
    permanents), and lands (handled by `slim_land`). Multiface cards are judged
    by their FRONT face — a back face's ability isn't available from hand.
    Returns (None, None) when the card doesn't qualify.
    """
    face = (card.get("card_faces") or [card])[0]
    type_line = face.get("type_line") or card.get("type_line") or ""
    main_types = type_line.split("—")[0]
    if "Land" in main_types or not any(t in main_types for t in _PERMANENT_TYPES):
        return None, None
    oracle = face.get("oracle_text") or ""
    colors = set()
    for line in oracle.split("\n"):
        # An "Add" inside reminder text or a quoted ability belongs to something
        # else — Treasure-token reminder text ('... artifacts with "{T},
        # Sacrifice this artifact: Add one mana of any color."') and abilities
        # granted to other permanents must not flag this card as a producer.
        line = re.sub(r"\([^)]*\)", "", line)
        line = re.sub(r'"[^"]*"', "", line)
        low = line.lower()
        if "add" not in low or ":" not in line:
            continue
        # Restricted-use mana ("Spend this mana only to cast an artifact
        # spell") isn't general fixing — the land parser files these under
        # condColors, so the producer flag stays conservative and skips them.
        if "spend this mana only" in low:
            continue
        cost, effect = line.split(":", 1)
        cost = cost.lower()
        if "{t}" not in cost:                    # ritual / non-tap engine: one-shot
            continue
        if "sacrifice" in cost:                  # Lotus Petal-style: one-shot
            continue
        colors |= _added_colors(effect)          # colorless-only adds stay empty
    if not colors:
        return None, None
    return sorted(colors), ("dork" if "Creature" in main_types else "rock")


def slim_card(card):
    # A spell//land modal DFC is a SPELL first (the front face); the joined
    # type/oracle text must not pollute its cost, smooth/fetch flags, or image.
    # Its land mode ships as `backLand` below.
    back = _back_land_face(card)
    grade = card
    if back is not None:
        front = card["card_faces"][0]
        grade = {
            "name": card["name"],
            "cmc": card.get("cmc", 0),
            "mana_cost": front.get("mana_cost", "") or "",
            "type_line": front.get("type_line", "") or "",
            "oracle_text": front.get("oracle_text", "") or "",
        }
    cost = grade.get("mana_cost") or ""
    if not cost and card.get("card_faces"):
        cost = card["card_faces"][0].get("mana_cost", "") or ""
    out = {
        "name": card["name"],
        "cost": cost,
        "type": card.get("type_line", ""),
        "image": _uris(card).get("small"),
        "smooth": _smooths(grade),
        "fetch": _fetches_land(grade),
    }
    if back is not None:
        colors, tapped = analyze_land_face(back)
        out["backLand"] = {"colors": colors, "tapped": tapped}
    mana_colors, mana_kind = _mana_producer(card)
    if mana_colors:
        out["manaColors"] = mana_colors
        out["manaKind"] = mana_kind
    return out


# ---------------------------------------------------------------------------
# output validation — sanity floors so a bad/partial Scryfall response can
# never ship a skewed snapshot (the workflow commits whatever this writes).
# Real counts as of mid-2026: ~268 lands, ~4700 cards.
# ---------------------------------------------------------------------------
MIN_LANDS = 200
MIN_CARDS = 3000
# A land contributes mana identity through plain colors, a fetch flag, or the
# conditional/gated color fields. Pure-colorless utility lands are a real part
# of the pool (~15% mid-2026), so the floor guards against a parsing collapse
# (everything colorless), not against utility lands existing.
MANA_IDENTITY_KEYS = ("colors", "fetch", "condColors", "gatedColors")
MIN_MANA_IDENTITY_FRACTION = 0.75
LAND_KEYS = ("name", "type", "rarity", "colors", "image", "image_hi", "basic", "tapped")
CARD_KEYS = ("name", "cost", "type", "image", "smooth", "fetch")


def validate_data(lands, cards):
    """Assert the built snapshot is sane; raise SystemExit (non-zero) if not."""
    problems = []
    if len(lands) < MIN_LANDS:
        problems.append("only {} lands (floor {})".format(len(lands), MIN_LANDS))
    if len(cards) < MIN_CARDS:
        problems.append("only {} cards (floor {})".format(len(cards), MIN_CARDS))

    for land in lands:
        missing = [k for k in LAND_KEYS if k not in land]
        if missing:
            problems.append("land {!r} missing keys: {}".format(
                land.get("name", "<unnamed>"), ", ".join(missing)))
            break  # one representative failure is enough
        # A pick-one land (land//land MDFC) must ship a usable face breakdown.
        if land.get("pickOne"):
            faces = land.get("faces") or []
            if len(faces) < 2 or any("colors" not in f or "tapped" not in f
                                     for f in faces):
                problems.append("pickOne land {!r} has a malformed `faces` "
                                "list".format(land.get("name", "<unnamed>")))
                break
    for card in cards.values():
        missing = [k for k in CARD_KEYS if k not in card]
        if missing:
            problems.append("card {!r} missing keys: {}".format(
                card.get("name", "<unnamed>"), ", ".join(missing)))
            break
        back = card.get("backLand")
        if back is not None and ("colors" not in back or "tapped" not in back):
            problems.append("card {!r} has a malformed `backLand`".format(
                card.get("name", "<unnamed>")))
            break
        if ("manaKind" in card) != ("manaColors" in card) or \
                card.get("manaKind") not in (None, "dork", "rock"):
            problems.append("card {!r} has inconsistent manaColors/manaKind"
                            .format(card.get("name", "<unnamed>")))
            break

    if lands:
        useful = sum(1 for l in lands
                     if any(l.get(k) for k in MANA_IDENTITY_KEYS))
        frac = useful / len(lands)
        if frac < MIN_MANA_IDENTITY_FRACTION:
            problems.append(
                "only {:.0%} of lands have a mana identity (floor {:.0%})".format(
                    frac, MIN_MANA_IDENTITY_FRACTION))

    if problems:
        raise SystemExit("build_data validation FAILED — not writing output:\n  "
                         + "\n  ".join(problems))


def write_outputs(lands, cards, meta):
    """Write the three JSONs atomically: all to temp files first, then rename
    into place only once every dump has succeeded — a mid-build failure can't
    leave docs/data/ with a fresh lands.json next to a stale cards.json."""
    OUT.mkdir(parents=True, exist_ok=True)
    payloads = [("lands.json", lands), ("cards.json", cards), ("meta.json", meta)]
    tmps = []
    try:
        for name, data in payloads:
            tmp = OUT / (name + ".tmp")
            with open(tmp, "w") as fh:
                json.dump(data, fh, separators=(",", ":"))
            tmps.append((tmp, OUT / name))
        for tmp, final in tmps:
            os.replace(tmp, final)
    finally:
        for tmp, _final in tmps:
            if tmp.exists():
                tmp.unlink()


def main():
    raw_lands = scryfall.standard_lands(force_refresh=True)
    # Spell//land modal DFCs match the land search (a land on either modal face
    # counts for `is_land`), but they are spells first — they ship in cards.json
    # with a `backLand` field instead, so drop them here rather than
    # double-counting them as standalone lands.
    lands = [slim_land(c) for c in land_mod.unique_lands(raw_lands)
             if _back_land_face(c) is None]

    all_cards = scryfall._search_all("legal:standard " + scryfall.legality_cutoff(), unique="cards")
    cards = {c["name"].lower(): slim_card(c) for c in all_cards}

    validate_data(lands, cards)

    meta = {
        "generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "lands": len(lands),
        "cards": len(cards),
    }
    write_outputs(lands, cards, meta)

    print("wrote {} lands, {} cards ({})".format(len(lands), len(cards), meta["generated"]))


if __name__ == "__main__":
    main()
