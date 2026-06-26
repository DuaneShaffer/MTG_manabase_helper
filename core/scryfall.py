"""On-demand card data from the Scryfall API, cached locally.

Replaces the committed multi-MB JSON dumps (which went stale) with live queries:

  * :func:`standard_lands` -- every Standard-legal land, one entry per card.
  * :func:`cards_by_names` -- resolve decklist card names to card objects.

Responses are cached under ``data/cache`` so the app works offline after the
first run and stays a good Scryfall citizen. Pass ``force_refresh=True`` (or
call :func:`refresh_standard_lands`) to re-fetch current data.

Scryfall request etiquette is followed: a descriptive User-Agent, an Accept
header, and a small delay between requests.
"""

import datetime
import time
from pathlib import Path

import requests

from core import config

API = "https://api.scryfall.com"
_HEADERS = {
    "User-Agent": "MTGManabaseHelper/1.0 (https://github.com/dlshaffer)",
    "Accept": "application/json",
}
_REQUEST_DELAY = 0.1            # Scryfall asks for 50-100ms between requests
_LANDS_TTL = 7 * 24 * 3600     # re-fetch the land list weekly
_COLLECTION_CHUNK = 75         # max identifiers per /cards/collection request

STANDARD_LANDS_QUERY = "legal:standard type:land"


def legality_cutoff():
    """Scryfall search clause limiting results to printings released on/before
    today. Scryfall marks spoiled-but-unreleased sets (e.g. a future set that
    reprints Standard staples) as ``legal:standard`` ahead of release, and the
    best-printing sort would then surface that not-yet-released printing. Pinning
    to today keeps the snapshot to what is actually available now."""
    return "date<=" + datetime.date.today().isoformat()


# --------------------------------------------------------------------------
# low-level HTTP + cache
# --------------------------------------------------------------------------
def _get(url, params=None, _attempts=5):
    for attempt in range(_attempts):
        time.sleep(_REQUEST_DELAY)
        resp = requests.get(url, params=params, headers=_HEADERS, timeout=30)
        if resp.status_code == 429 and attempt < _attempts - 1:
            # Rate limited — back off (honor Retry-After if given) and retry.
            wait = float(resp.headers.get("Retry-After", 1.5)) + 0.5 * attempt
            time.sleep(wait)
            continue
        resp.raise_for_status()
        return resp.json()


def _post(url, payload):
    time.sleep(_REQUEST_DELAY)
    resp = requests.post(url, json=payload, headers=_HEADERS, timeout=30)
    resp.raise_for_status()
    return resp.json()


def _cache_file(name):
    return Path(config.CACHE_DIR) / (name + ".json")


def _read_cache(name, ttl=None):
    path = _cache_file(name)
    if not path.is_file():
        return None
    if ttl is not None and (time.time() - path.stat().st_mtime) > ttl:
        return None
    return config.load_json(path)


def _write_cache(name, data):
    config.save_json(_cache_file(name), data)


def _search_all(query, unique="cards"):
    """Fetch every page of a Scryfall search query."""
    results = []
    page = _get(API + "/cards/search", {"q": query, "unique": unique})
    results.extend(page.get("data", []))
    while page.get("has_more"):
        page = _get(page["next_page"])
        results.extend(page.get("data", []))
    return results


# --------------------------------------------------------------------------
# public API
# --------------------------------------------------------------------------
# In-process memos so we don't re-read+parse the cache files on every request.
_lands_mem = None
_index_mem = None


def standard_lands(force_refresh=False):
    """All Standard-legal lands (one printing per card), cached weekly.

    Memoised in process: the on-disk JSON is parsed at most once per run (until
    a forced refresh).
    """
    global _lands_mem
    if not force_refresh and _lands_mem is not None:
        return _lands_mem
    if not force_refresh:
        cached = _read_cache("standard_lands", ttl=_LANDS_TTL)
        if cached is not None:
            _lands_mem = cached
            return _lands_mem
    lands = _search_all(STANDARD_LANDS_QUERY + " " + legality_cutoff(), unique="cards")
    _write_cache("standard_lands", lands)
    _lands_mem = lands
    return _lands_mem


def refresh_standard_lands():
    """Force a re-fetch of the Standard land list and return it."""
    return standard_lands(force_refresh=True)


def cards_by_names(names, force_refresh=False):
    """Resolve card names to Scryfall card objects, preserving input order.

    Looked-up cards are memoised in ``data/cache/card_index.json`` so repeated
    deck loads only fetch names not seen before. Names Scryfall can't match are
    silently dropped (mirrors the original behaviour).
    """
    global _index_mem
    if force_refresh:
        index = {}
    else:
        index = _index_mem if _index_mem is not None else (_read_cache("card_index") or {})

    missing = [n for n in dict.fromkeys(names) if n not in index]
    if missing:
        for i in range(0, len(missing), _COLLECTION_CHUNK):
            batch = missing[i:i + _COLLECTION_CHUNK]
            payload = {"identifiers": [{"name": n} for n in batch]}
            data = _post(API + "/cards/collection", payload)
            for card in data.get("data", []):
                index[card["name"]] = card
        _write_cache("card_index", index)
    _index_mem = index

    # Match by exact name first, then case-insensitively (decklist casing varies).
    lower = {k.lower(): v for k, v in index.items()}
    resolved = []
    for name in names:
        card = index.get(name) or lower.get(name.lower())
        if card is not None:
            resolved.append(card)
    return resolved
