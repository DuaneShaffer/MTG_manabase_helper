# MTG Manabase Helper

A free, browser-based tool for building **Magic: The Gathering** manabases. Paste a Standard
decklist and it tells you how many sources of each color you need, grades how reliably you'll
cast each card on curve, recommends a concrete set of lands, and stress-tests the build by
simulating thousands of games.

**▶ Live app: <https://duaneshaffer.github.io/MTG_manabase_helper/>**

No install, no account, no server — everything runs in your browser.

## What it does

- **Per-color requirements** from Frank Karsten's conditional-hypergeometric model, with a
  sliding (89 + mana value)% confidence target you can override.
- **Per-card castability grades** (A–F) overlaid on your deck, so you can see exactly which
  cards a manabase lets you down on.
- **Recommended land count** derived from your curve, adjusted for cheap card draw/ramp.
- **A "Build manabase" recommender** that picks lands to cover your colors, preferring untapped
  sources and capping taplands.
- **Monte-Carlo simulation** ("Simulate") that plays out thousands of real games — mulligans,
  draws, tapped lands — and reports true on-curve odds *including* mana screw and flood.
- Smart land handling: dual/utility lands, choose-a-color and "any color" lands, and
  conditional lands that only fix when your deck has the right spells.

## Running locally

The app is the static `docs/` folder. To preview it:

```bash
cd docs && python3 -m http.server      # then open http://localhost:8000
```

To run the tests (Python 3, `pip install -r requirements.txt`):

```bash
python -m pytest tests/ -q                        # the data-pipeline tests
for f in docs/js/tests/*.test.js; do node "$f"; done   # the app's math/deck/sim tests
```

## How it's built

A fully static client-side app (vanilla ES modules in `docs/js/`) with a committed snapshot of
Scryfall card data under `docs/data/` — so end users never hit Scryfall's API (card images
hotlink its CDN, which Scryfall permits). A GitHub Action refreshes that snapshot weekly via
the Python data pipeline (`scripts/build_data.py` + `core/`), which validates the snapshot
before anything ships.

## License

See [LICENSE](LICENSE).
