// Live hypergeometric source-count model.
//
// Faithful port of core/hypergeometric.py. Karsten's *conditional* castability:
//
//   P(>= pips colored sources AND >= M lands by turn M) / P(>= M lands by turn M)
//
// Exact combinatorics use BigInt; only the final probability ratio converts to
// Number. comb() and the conditional probability are memoised in Maps keyed by
// a string of their arguments, mirroring Python's lru_cache.

import { COLORS } from "./colors.js";

const THRESHOLD_CAP = 0.99; // targets above this can be unreachable; clamp

// --- exact binomial coefficient (BigInt), memoised -------------------------

const _combCache = new Map();

/**
 * Binomial coefficient C(n, k) as a BigInt. Returns 0n for out-of-range k.
 * @param {number} n
 * @param {number} k
 * @returns {bigint}
 */
export function comb(n, k) {
  if (k < 0 || k > n || n < 0) return 0n;
  if (k === 0 || k === n) return 1n;
  const key = n + "," + k;
  const cached = _combCache.get(key);
  if (cached !== undefined) return cached;
  // Use the smaller of k and n-k for fewer iterations.
  let kk = k;
  if (kk > n - kk) kk = n - kk;
  let result = 1n;
  const N = BigInt(n);
  for (let i = 0n; i < BigInt(kk); i++) {
    result = (result * (N - i)) / (i + 1n);
  }
  _combCache.set(key, result);
  return result;
}

/**
 * Cards seen by the given turn (opening 7 plus one per draw step).
 * @param {number} turn
 * @param {boolean} [onPlay=true]
 * @returns {number}
 */
export function cardsSeen(turn, onPlay = true) {
  return onPlay ? 7 + (turn - 1) : 7 + turn;
}

/**
 * Karsten's sliding confidence target: (89 + M)%, clamped to THRESHOLD_CAP.
 * @param {number} mv
 * @returns {number}
 */
export function thresholdFor(mv) {
  return Math.min((89 + mv) / 100.0, THRESHOLD_CAP);
}

/**
 * Karsten's 60-card analysis assumes ~25 lands; scale for other sizes.
 * @param {number} deckSize
 * @returns {number}
 */
export function assumedLandCount(deckSize) {
  return Math.max(1, pyRound((deckSize * 25) / 60));
}

// Python's round() uses banker's rounding (round-half-to-even).
function pyRound(x) {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  // exactly .5 -> round to even
  return floor % 2 === 0 ? floor : floor + 1;
}

// --- conditional probability (exact, memoised) -----------------------------

const _condCache = new Map();

/**
 * P(>=pips colored AND >=M lands | seen) / P(>=M lands | seen). Memoised.
 * Three deck categories: `sources` colored sources, `lands - sources` other
 * lands, the rest nonland.
 * @param {number} pips
 * @param {number} mv  mana value (M, the lands-on-curve target)
 * @param {number} deckSize
 * @param {number} lands
 * @param {number} sources
 * @param {number} seen
 * @returns {number}
 */
export function conditionalProb(pips, mv, deckSize, lands, sources, seen) {
  const key = [pips, mv, deckSize, lands, sources, seen].join(",");
  const cached = _condCache.get(key);
  if (cached !== undefined) return cached;

  const M = mv;
  const otherLands = lands - sources;
  const nonland = deckSize - lands;

  let numerator = 0n;
  for (let a = pips; a <= Math.min(sources, seen); a++) {
    const bMax = Math.min(otherLands, seen - a);
    for (let b = Math.max(0, M - a); b <= bMax; b++) {
      numerator +=
        comb(sources, a) * comb(otherLands, b) * comb(nonland, seen - a - b);
    }
  }

  let denominator = 0n;
  for (let t = M; t <= Math.min(lands, seen); t++) {
    denominator += comb(lands, t) * comb(deckSize - lands, seen - t);
  }

  const result = denominator === 0n ? 0.0 : Number(numerator) / Number(denominator);
  _condCache.set(key, result);
  return result;
}

/**
 * Probability of casting a `pips`-pip, MV-`mv` spell on curve given `sources`
 * colored sources in the deck. 1.0 if no pips required.
 * @param {number} pips
 * @param {number} mv
 * @param {number} sources
 * @param {number} [deckSize=60]
 * @param {?number} [lands=null]
 * @param {boolean} [onPlay=true]
 * @returns {number}
 */
export function castableProbability(pips, mv, sources, deckSize = 60, lands = null, onPlay = true) {
  if (pips <= 0) return 1.0;
  if (lands === null) lands = assumedLandCount(deckSize);
  sources = Math.min(sources, lands);
  const seen = cardsSeen(Math.max(mv, pips), onPlay);
  return conditionalProb(pips, mv, deckSize, lands, sources, seen);
}

/**
 * Smallest in-deck colored-source count to hit the confidence target.
 * `threshold` overrides the sliding default (e.g. pass 0.95 for a flat 95%).
 * @param {number} pips
 * @param {number} mv
 * @param {number} [deckSize=60]
 * @param {?number} [lands=null]
 * @param {?number} [threshold=null]
 * @param {boolean} [onPlay=true]
 * @returns {number}
 */
export function sourcesNeeded(pips, mv, deckSize = 60, lands = null, threshold = null, onPlay = true) {
  if (pips <= 0) return 0;
  if (lands === null) lands = assumedLandCount(deckSize);
  const target = threshold !== null ? threshold : thresholdFor(mv);
  const seen = cardsSeen(Math.max(mv, pips), onPlay);
  for (let sources = pips; sources <= lands; sources++) {
    if (conditionalProb(pips, mv, deckSize, lands, sources, seen) >= target) {
      return sources;
    }
  }
  return lands;
}

// Letter grades bracketing Karsten's ~90% target.
const _GRADE_BANDS = [
  [0.95, "A", "Excellent"],
  [0.9, "B", "Good"],
  [0.8, "C", "Risky"],
  [0.65, "D", "Poor"],
  [0.0, "F", "Unreliable"],
];

/**
 * Map a probability to a { letter, label } grade.
 * @param {number} probability
 * @returns {{letter:string, label:string}}
 */
export function grade(probability) {
  for (const [floor, letter, label] of _GRADE_BANDS) {
    if (probability >= floor) return { letter, label };
  }
  return { letter: "F", label: "Unreliable" };
}

/**
 * Exact multivariate castability (no Python equivalent).
 *
 * Probability of having >= each color's required pips simultaneously AND
 * >= mv total lands, conditioned on >= mv lands. Sources per color are assumed
 * disjoint (mono sources). Deck categories: one colored bucket per needed
 * color, an "other lands" bucket = lands - sum(sourcesByColor), and a nonland
 * bucket = deckSize - lands. Multivariate hypergeometric over these buckets.
 *
 * Falls back to castableProbability when 0 or 1 colors are needed.
 *
 * @param {Object.<string,number>} pipsByColor  required pips per color
 * @param {number} mv
 * @param {Object.<string,number>} sourcesByColor  colored sources per color
 * @param {number} [deckSize=60]
 * @param {?number} [lands=null]
 * @param {boolean} [onPlay=true]
 * @returns {number}
 */
export function multivariateCastable(pipsByColor, mv, sourcesByColor, deckSize = 60, lands = null, onPlay = true) {
  // Needed colors = those with a positive pip requirement.
  const needed = [];
  for (const c of COLORS) {
    const p = pipsByColor[c] || 0;
    if (p > 0) needed.push(c);
  }

  if (needed.length === 0) return 1.0;
  if (needed.length === 1) {
    const c = needed[0];
    return castableProbability(pipsByColor[c], mv, sourcesByColor[c] || 0, deckSize, lands, onPlay);
  }

  if (lands === null) lands = assumedLandCount(deckSize);
  const M = mv;
  // Pip count drives "seen" alongside mv, matching the single-color model.
  const maxPips = Math.max(...needed.map((c) => pipsByColor[c]));
  const seen = cardsSeen(Math.max(mv, maxPips), onPlay);

  // Bucket sizes: one per needed color, plus other-lands, plus nonland. The
  // buckets must form a valid partition of the deck (colors + otherLands +
  // nonland === deckSize), so the total colored sources cannot exceed `lands`.
  // When the caller's sources oversubscribe the land slots (sources are
  // assumed disjoint here), proportionally scale them down to fit `lands`.
  let colorSizes = needed.map((c) => sourcesByColor[c] || 0);
  let sumSources = 0;
  for (const s of colorSizes) sumSources += s;
  if (sumSources > lands) {
    const scale = lands / sumSources;
    colorSizes = colorSizes.map((s) => Math.floor(s * scale));
    sumSources = 0;
    for (const s of colorSizes) sumSources += s;
  }
  const otherLands = Math.max(0, lands - sumSources);
  const nonland = deckSize - lands;
  const requiredPips = needed.map((c) => pipsByColor[c]);

  // Numerator: sum over multivariate-hypergeometric arrangements where each
  // color's drawn >= its pips AND total lands drawn >= M, of the multinomial
  // count product(C(bucket_i, draw_i)) with draws summing to `seen`.
  let numerator = 0n;

  // Recurse over color buckets, then other-lands, then nonland is determined.
  const nColors = needed.length;
  const colorDraws = new Array(nColors);

  function recurse(idx, drawnSoFar, coloredLandsSoFar) {
    if (idx === nColors) {
      // Remaining cards after color buckets are filled.
      const remaining = seen - drawnSoFar;
      if (remaining < 0) return;
      // other-lands count `b` from max(0, M - coloredLandsSoFar) up; nonland
      // takes the rest. total lands = coloredLandsSoFar + b must be >= M and
      // nonland draw must be valid.
      const bMin = Math.max(0, M - coloredLandsSoFar);
      const bMax = Math.min(otherLands, remaining);
      for (let b = bMin; b <= bMax; b++) {
        const nl = remaining - b;
        if (nl < 0 || nl > nonland) continue;
        // multinomial count for this full arrangement
        let term = comb(otherLands, b) * comb(nonland, nl);
        for (let i = 0; i < nColors; i++) {
          term *= comb(colorSizes[i], colorDraws[i]);
        }
        numerator += term;
      }
      return;
    }
    const size = colorSizes[idx];
    const need = requiredPips[idx];
    const aMax = Math.min(size, seen - drawnSoFar);
    for (let a = need; a <= aMax; a++) {
      colorDraws[idx] = a;
      recurse(idx + 1, drawnSoFar + a, coloredLandsSoFar + a);
    }
  }
  recurse(0, 0, 0);

  // Denominator: P(>= M lands) over all lands vs nonland.
  let denominator = 0n;
  for (let t = M; t <= Math.min(lands, seen); t++) {
    denominator += comb(lands, t) * comb(deckSize - lands, seen - t);
  }

  return denominator === 0n ? 0.0 : Number(numerator) / Number(denominator);
}
