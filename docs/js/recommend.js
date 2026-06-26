// Recommend a manabase: turn per-color source requirements into concrete land
// counts. An improved greedy heuristic over the Python first-cut version in
// core/recommend.py -- it now accounts for untapped-vs-tapped lands (with a
// tapland cap) and an optional land-count target to top up toward.

import { COLORS } from "./colors.js";

const NONBASIC_MAX = 4; // singleton/playset rule for non-basic lands

// Recommend a land count from the deck's average mana value, using Karsten's
// draw/ramp-aware regression:
//   base = 19.59 + 1.90 * avgMV - 0.28 * smoothCount
// where smoothCount is the number of cheap card-draw / ramp / dig spells (each
// lets you run slightly fewer lands). Scaled by deckSize/60 and clamped.
export function recommendLandCount(avgMV, deckSize = 60, smoothCount = 0) {
  const scale = deckSize / 60;
  const base = (19.59 + 1.90 * avgMV - 0.28 * smoothCount) * scale;
  const lo = Math.round(16 * scale);
  const hi = Math.round(28 * scale);
  return Math.min(hi, Math.max(lo, Math.round(base)));
}

// The colors a land view object produces, intersected with WUBRG order.
function landColors(land) {
  const produced = land.colors || [];
  return COLORS.filter((c) => produced.includes(c));
}

// Recommend land counts to satisfy per-color source `requirements`.
//
// requirements: object over WUBRG of needed sources.
// lands: array of land view objects ({name, colors:[...], basic, tapped, ...}).
// opts: { landTarget=null, maxLands=null, taplandCap=9 }
//
// Returns { counts, cards, sources, met, total, shortfall, taplands }.
export function recommend(requirements, lands, opts = {}) {
  const landTarget = opts.landTarget ?? null;
  const maxLands = opts.maxLands ?? null;
  const taplandCap = opts.taplandCap ?? 9;

  const remaining = {};
  const sources = {};
  for (const c of COLORS) {
    remaining[c] = requirements[c] || 0;
    sources[c] = 0;
  }
  const needed = new Set(COLORS.filter((c) => (requirements[c] || 0) > 0));

  const counts = {};
  const chosen = {};
  let total = 0;
  let taplands = 0;

  // Candidate pool: lands producing at least one needed color, each tagged with
  // the colors it makes, whether it's basic, and whether it enters tapped.
  const pool = [];
  for (const land of lands) {
    const colors = landColors(land);
    if (colors.some((c) => needed.has(c))) {
      pool.push({
        land,
        name: land.name,
        colors,
        basic: !!land.basic,
        tapped: !!land.tapped,
      });
    }
  }

  // Score a candidate by the number of still-deficit colors it produces.
  const scoreOf = (cand) => cand.colors.reduce((n, c) => n + (remaining[c] > 0 ? 1 : 0), 0);

  // Phase 1: satisfy requirements.
  while (COLORS.some((c) => remaining[c] > 0)) {
    if (maxLands !== null && total >= maxLands) {
      break;
    }

    // Best untapped score, to gate whether a tapland may exceed the cap.
    let bestUntappedScore = 0;
    for (const cand of pool) {
      if (cand.tapped) continue;
      if (!cand.basic && (counts[cand.name] || 0) >= NONBASIC_MAX) continue;
      const s = scoreOf(cand);
      if (s > bestUntappedScore) bestUntappedScore = s;
    }

    let best = null;
    // key: [deficit colors covered, untapped (1) over tapped (0), nonbasic (1)
    // over basic (0)]. Higher wins lexicographically.
    let bestKey = [0, 0, 0];

    for (const cand of pool) {
      if (!cand.basic && (counts[cand.name] || 0) >= NONBASIC_MAX) continue;
      const score = scoreOf(cand);
      if (score === 0) continue;

      // If adding this tapped land would push tapland copies over the cap, only
      // allow it when no untapped candidate has an equal-or-better score.
      if (cand.tapped && taplands + 1 > taplandCap) {
        if (bestUntappedScore >= score) continue;
      }

      const key = [score, cand.tapped ? 0 : 1, cand.basic ? 0 : 1];
      if (
        key[0] > bestKey[0] ||
        (key[0] === bestKey[0] &&
          (key[1] > bestKey[1] ||
            (key[1] === bestKey[1] && key[2] > bestKey[2])))
      ) {
        bestKey = key;
        best = cand;
      }
    }

    if (best === null) {
      break; // nothing left can help
    }

    counts[best.name] = (counts[best.name] || 0) + 1;
    chosen[best.name] = best.land;
    total += 1;
    if (best.tapped) taplands += 1;
    for (const color of best.colors) {
      sources[color] += 1;
      if (remaining[color] > 0) remaining[color] -= 1;
    }
  }

  // Phase 2: top up toward landTarget with basics for the colors with the
  // smallest surplus (most-needed first); never exceed maxLands.
  if (landTarget !== null && total < landTarget) {
    // Map each needed color to an untapped basic that produces it.
    const basicFor = {};
    for (const cand of pool) {
      if (cand.basic && !cand.tapped && cand.colors.length === 1) {
        const c = cand.colors[0];
        if (!(c in basicFor)) basicFor[c] = cand;
      }
    }
    // Colors we can top up with, ordered by current surplus (sources - req),
    // smallest first => most-needed first.
    while (total < landTarget) {
      if (maxLands !== null && total >= maxLands) break;
      const candidates = COLORS.filter((c) => basicFor[c]);
      if (candidates.length === 0) break;
      candidates.sort(
        (a, b) =>
          sources[a] - (requirements[a] || 0) - (sources[b] - (requirements[b] || 0)),
      );
      const c = candidates[0];
      const cand = basicFor[c];
      counts[cand.name] = (counts[cand.name] || 0) + 1;
      chosen[cand.name] = cand.land;
      total += 1;
      sources[c] += 1;
    }
  }

  const met = {};
  for (const c of COLORS) met[c] = sources[c] >= (requirements[c] || 0);

  const shortfall = {};
  for (const c of COLORS) if (remaining[c] > 0) shortfall[c] = remaining[c];

  const outCounts = {};
  for (const [name, n] of Object.entries(counts)) if (n > 0) outCounts[name] = n;

  return {
    counts: outCounts,
    cards: chosen,
    sources,
    met,
    total,
    shortfall,
    taplands,
  };
}
