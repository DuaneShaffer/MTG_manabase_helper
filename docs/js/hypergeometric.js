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
import { recommendLandCount } from "./recommend.js";

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

// --- plain (unconditional) hypergeometric, memoised -----------------------

const _atLeastCache = new Map();

/**
 * P(draw >= k successes) for a sample of `sample` from `population`, where there
 * are `successes` successes in the population. Plain hypergeometric — distinct
 * from the conditional castability model. Powers the draw-odds query tool.
 * @param {number} population
 * @param {number} successes
 * @param {number} sample
 * @param {number} k
 * @returns {number}
 */
export function hypergeomAtLeast(population, successes, sample, k) {
  if (k <= 0) return 1.0;
  sample = Math.min(sample, population);
  if (k > successes || k > sample) return 0.0;
  const key = [population, successes, sample, k].join(",");
  const cached = _atLeastCache.get(key);
  if (cached !== undefined) return cached;
  const denom = comb(population, sample);
  if (denom === 0n) return 0.0;
  const lo = Math.max(k, sample - (population - successes));
  const hi = Math.min(successes, sample);
  let numer = 0n;
  for (let x = lo; x <= hi; x++) {
    numer += comb(successes, x) * comb(population - successes, sample - x);
  }
  const result = Number(numer) / Number(denom);
  _atLeastCache.set(key, result);
  return result;
}

/**
 * P(>= k of `successes` copies seen by `turn`), on the play or draw.
 * @param {number} deckSize
 * @param {number} successes
 * @param {number} k
 * @param {number} turn
 * @param {boolean} [onPlay=true]
 * @returns {number}
 */
export function drawOddsByTurn(deckSize, successes, k, turn, onPlay = true) {
  return hypergeomAtLeast(deckSize, successes, cardsSeen(turn, onPlay), k);
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

/**
 * Intended final deck size for a SPELL-ONLY pasted list: the smallest deck
 * (>= 60) that self-consistently holds `spellCount` spells plus its own
 * recommended land count, i.e. the fixed point of
 *
 *   deckSize = max(60, spellCount + recommendLandCount(avgMV, deckSize, smooth))
 *
 * recommendLandCount is linear in deckSize before its rounding/clamping, so
 * the closed form deckSize = S / (1 - base60/60) seeds the answer; a short
 * monotone iteration then settles the exact rounded/clamped fixed point
 * (recommendLandCount is nondecreasing in deckSize with slope < 1, so the
 * iteration converges — no oscillation).
 *
 * For the common case (36 spells, ~24-land curve) this is exactly 60.
 * @param {number} spellCount  total nonland cards pasted
 * @param {number} avgMV
 * @param {number} [smoothCount=0]
 * @returns {number}
 */
export function assumedDeckSize(spellCount, avgMV, smoothCount = 0) {
  if (spellCount <= 0) return 60;
  // Closed-form seed (regression constants mirror recommendLandCount; the
  // iteration below is authoritative, this only picks the starting point).
  const discount = Math.min(3, 0.28 * smoothCount);
  const base60 = 19.59 + 1.90 * avgMV - discount;
  const landRatio = Math.max(0, Math.min(base60, 28)) / 60; // 28 = the clamp ceiling
  let d = Math.max(60, Math.round(spellCount / (1 - landRatio)));
  for (let i = 0; i < 20; i++) {
    const next = Math.max(60, spellCount + recommendLandCount(avgMV, d, smoothCount));
    if (next === d) break;
    d = next;
  }
  return d;
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
 * Approximate multivariate castability from per-color source COUNTS alone.
 *
 * DEPRECATED as the primary gold-card model: it assumes the per-color source
 * buckets are disjoint (a WU dual credited to both colors gets floor-scaled
 * into separate W and U buckets when the counts oversubscribe the land total),
 * which systematically underestimates dual-heavy manabases. Prefer
 * buildCastable(), which models the ACTUAL land composition exactly. This is
 * kept only as the graceful fallback for grading without a concrete build
 * (per-color source counts are all the information there is).
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

// --- exact gold-card castability against the ACTUAL build --------------------

const _buildCache = new Map();

/**
 * Exact castability of a (possibly gold / hybrid) spell against the ACTUAL
 * land build — no disjoint-bucket approximation. Each land is projected onto
 * the card's needed color set C: its category is (effective colors ∩ C), so a
 * WU dual is one land payable as EITHER pip. The deck is then the multivariate
 * hypergeometric over these categories (plus lands producing none of C, plus
 * nonlands), and a drawn multiset of lands pays the pips iff Hall's condition
 * holds: for every non-empty subset S ⊆ C,
 *
 *   (# drawn lands producing a color in S) >= (# pips payable only within S)
 *
 * Hard pips of color c count toward every S containing c; a two-color hybrid
 * pip counts toward S only when BOTH its colors lie in S — so hybrid pips are
 * handled exactly, with no resolve-to-one-color approximation.
 *
 * Conditioning matches the univariate model: P(payable AND >= mv lands among
 * `seen`) / P(>= mv lands), seen = cardsSeen(max(mv, total pips)). For a
 * mono-color card (no hybrids) this reduces to — and returns via —
 * castableProbability, exactly.
 *
 * @param {Object.<string,number>} pipsByColor  hard pips per color
 * @param {number} mv
 * @param {Array<[string,string]>} hybrids  two-color hybrid pip pairs
 * @param {Array<{count:number, colors:string[]}>} landGroups  the real build,
 *   each land with its EFFECTIVE colors
 * @param {number} [deckSize=60]
 * @param {boolean} [onPlay=true]
 * @returns {number}
 */
export function buildCastable(pipsByColor, mv, hybrids, landGroups, deckSize = 60, onPlay = true) {
  hybrids = hybrids || [];
  // Needed color set C, in WUBRG order.
  const inC = new Set();
  for (const c of COLORS) if ((pipsByColor[c] || 0) > 0) inC.add(c);
  for (const pair of hybrids) for (const c of pair) inC.add(c);
  const C = COLORS.filter((c) => inC.has(c));
  const k = C.length;

  let totalLands = 0;
  for (const g of landGroups) totalLands += g.count;

  if (k === 0) return 1.0;
  // Mono-color, no hybrids: the exact model reduces to the univariate one —
  // bail to it (it's the hot path; gold cards are the minority).
  if (k === 1 && hybrids.length === 0) {
    const c = C[0];
    let sources = 0;
    for (const g of landGroups) if ((g.colors || []).includes(c)) sources += g.count;
    return castableProbability(pipsByColor[c], mv, sources, deckSize, totalLands, onPlay);
  }

  const bit = {};
  C.forEach((c, i) => { bit[c] = 1 << i; });
  const nSub = 1 << k;

  // Land categories: catCounts[mask] = lands whose effective colors ∩ C = mask
  // (mask 0 = a land producing none of the needed colors — still a land drop).
  const catCounts = new Array(nSub).fill(0);
  for (const g of landGroups) {
    let m = 0;
    for (const c of g.colors || []) if (bit[c] !== undefined) m |= bit[c];
    catCounts[m] += g.count;
  }

  // Pips that can only be paid from inside each color subset S.
  let totalPips = hybrids.length;
  for (const c of C) totalPips += pipsByColor[c] || 0;
  const needsWithin = new Array(nSub).fill(0);
  for (let S = 1; S < nSub; S++) {
    let n = 0;
    for (let i = 0; i < k; i++) if (S & (1 << i)) n += pipsByColor[C[i]] || 0;
    for (const pair of hybrids) {
      const m = bit[pair[0]] | bit[pair[1]];
      if ((m & S) === m) n += 1;
    }
    needsWithin[S] = n;
  }

  const M = mv;
  const seen = cardsSeen(Math.max(mv, totalPips), onPlay);
  const nonland = Math.max(0, deckSize - totalLands);

  const key = [
    mv, deckSize, onPlay ? 1 : 0, C.join(""),
    C.map((c) => pipsByColor[c] || 0).join(","),
    hybrids.map((p) => bit[p[0]] | bit[p[1]]).sort((a, b) => a - b).join(","),
    catCounts.join(","),
  ].join("|");
  const cached = _buildCache.get(key);
  if (cached !== undefined) return cached;

  // Only the categories actually present, and only the Hall subsets with a
  // real demand, participate in the enumeration.
  const cats = [];
  for (let m = 0; m < nSub; m++) if (catCounts[m] > 0) cats.push({ mask: m, n: catCounts[m] });
  const checks = [];
  for (let S = 1; S < nSub; S++) if (needsWithin[S] > 0) checks.push(S);

  // Numerator: sum over category compositions (a_0..a_c lands drawn per
  // category, nonlands taking the rest of `seen`) that draw >= M lands AND
  // satisfy Hall, of the multivariate-hypergeometric count.
  let numerator = 0n;
  const draws = new Array(cats.length).fill(0);
  const recurse = (idx, drawnLands, weight) => {
    if (idx === cats.length) {
      if (drawnLands < M) return;
      const nl = seen - drawnLands;
      if (nl < 0 || nl > nonland) return;
      for (const S of checks) {
        let have = 0;
        for (let j = 0; j < cats.length; j++) if (cats[j].mask & S) have += draws[j];
        if (have < needsWithin[S]) return;
      }
      numerator += weight * comb(nonland, nl);
      return;
    }
    const aMax = Math.min(cats[idx].n, seen - drawnLands);
    for (let a = 0; a <= aMax; a++) {
      draws[idx] = a;
      recurse(idx + 1, drawnLands + a, weight * comb(cats[idx].n, a));
    }
  };
  recurse(0, 0, 1n);

  // Denominator: P(>= M lands among seen), identical to the univariate model.
  let denominator = 0n;
  for (let t = M; t <= Math.min(totalLands, seen); t++) {
    denominator += comb(totalLands, t) * comb(nonland, seen - t);
  }

  const result = denominator === 0n ? 0.0 : Number(numerator) / Number(denominator);
  _buildCache.set(key, result);
  return result;
}
