"""Central configuration: file paths and the data directory layout.

Card data is fetched on demand from Scryfall (see ``core.scryfall``) and cached
under ``data/``; nothing large is committed to the repo anymore. Paths resolve
relative to the repository root so the tool runs from a clean checkout, and any
path can be overridden with an environment variable of the same name.
"""

import json
import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def _path(env_var, default_rel):
    """Repo-relative default, overridable by an environment variable."""
    override = os.environ.get(env_var)
    return Path(override) if override else REPO_ROOT / default_rel


# Generated / cached artifacts live under data/ (git-ignored).
DATA_DIR = _path("MTG_DATA_DIR", "data")
CACHE_DIR = _path("MTG_CACHE_DIR", "data/cache")   # Scryfall JSON responses
PNG_DIR = _path("MTG_PNG_DIR", "data/images")      # downloaded card art

# Tracked inputs.
EXAMPLE_DECK = _path("MTG_EXAMPLE_DECK", "example_deck.txt")


def load_json(path):
    with open(path, "r") as fh:
        return json.load(fh)


def save_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as fh:
        json.dump(data, fh)
