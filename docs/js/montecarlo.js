// Monte-Carlo castability validator.
//
// The closed-form grade (hypergeometric) conditions on hitting your land drops —
// it measures colour reliability, not raw mana screw. This simulator instead
// plays out real games: shuffle, London-mulligan to a keepable hand, draw to the
// turn you'd cast each card, and check whether you can actually cast it on curve.
// The resulting probability folds in BOTH not-enough-lands and wrong-colours.
//
// Card draw is modelled approximately: `drawCount` cheap card-draw / dig spells
// become "dig" tokens; each one you've seen by the cast turn lets you look one
// card deeper for a land (a cantrip cycling toward your next land). Of those,
// `fetchCount` are land-fetch/ramp spells ("fetch" tokens) that instead pull a
// land of the color you most need — so they fix colors, not just find lands.
// Casting timing and mana cost are idealized — it captures the smoothing
// direction, not exact sequencing.
//
// Other simplifications: London mulligan keeping 2–5 lands (≤3 mulls); one land
// drop per turn; a hand of only tapped lands can't cast on curve; fetched lands
// enter tapped; scry-to-bottom policies aren't modelled.

const isLand = (c) => c !== null && typeof c === "object";

// Seeded PRNG (mulberry32) — lets the caller put every candidate build on the same
// per-trial draws (common random numbers) for low-variance comparisons.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(a, rng) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Deck template: a {colors, tapped, basic, needsBasic} token per land copy,
// "fetch" per land-fetch/ramp spell (resolves to a chosen color), "draw" per other
// dig spell, null for inert filler.
function buildDeck(buildLands, deckSize, drawCount, fetchCount) {
  const deck = [];
  for (const l of buildLands) {
    for (let i = 0; i < l.count; i++) deck.push({ colors: l.colors, tapped: !!l.tapped, basic: !!l.basic, needsBasic: !!l.needsBasic, slow: !!l.slow, untapBasic: !!l.untapBasic });
  }
  const fetches = Math.max(0, Math.min(fetchCount || 0, drawCount));
  for (let i = 0; i < fetches; i++) deck.push("fetch");
  for (let i = 0; i < drawCount - fetches; i++) deck.push("draw");
  for (let i = deck.length; i < deckSize; i++) deck.push(null);
  return deck;
}

// London mulligan: returns the kept hand + remaining library (in draw order),
// plus the kept hand size (7/6/5/4 — London bottoms one per mulligan) and the
// number of mulligans taken.
function drawGame(deck, rng) {
  let mulls = 0;
  while (true) {
    shuffle(deck, rng);
    const hand = deck.slice(0, 7);
    const nLands = hand.filter(isLand).length;
    if ((nLands >= 2 && nLands <= 5) || mulls >= 3) {
      const library = deck.slice(7);
      for (let i = 0; i < mulls; i++) {                  // bottom toward ~3 lands
        const lands = hand.filter(isLand).length;
        let idx = lands > 3 ? hand.findIndex(isLand) : hand.findIndex((c) => !isLand(c));
        if (idx < 0) idx = 0;
        library.push(hand[idx]);
        hand.splice(idx, 1);
      }
      return { hand, library, kept: hand.length, mulls };
    }
    mulls++;
  }
}

// A fetch/ramp spell pulls a land you choose — so resolve each available fetch to
// the color the spell still needs most (largest required-minus-held deficit among
// its hard pips, else a hybrid color it lacks). The fetched land enters tapped
// (conservative) but counts toward the land drop and supplies its color.
function resolveFetches(lands, fetches, pips, hybrids) {
  for (let f = 0; f < fetches; f++) {
    const have = {};
    for (const l of lands) for (const c of l.colors) have[c] = (have[c] || 0) + 1;
    let pick = null, bestDef = -Infinity;
    for (const c in pips) {
      const def = pips[c] - (have[c] || 0);
      if (def > bestDef) { bestDef = def; pick = c; }
    }
    if (pick === null) {  // no hard pips: target a hybrid color we hold least of
      for (const pair of hybrids || []) for (const c of pair) {
        const def = 1 - (have[c] || 0);
        if (def > bestDef) { bestDef = def; pick = c; }
      }
    }
    lands.push({ colors: pick ? [pick] : [], tapped: true, basic: true });
  }
}

// Can the colored needs be paid by distinct lands? (bipartite matching; duals ok)
// Each `need` is an array of acceptable colors: a hard pip is a single-color need
// (e.g. ["W"]); a two-color hybrid pip accepts either color (e.g. ["W","U"]).
function canPayNeeds(needs, landColors) {
  if (!needs.length) return true;
  const matchTo = new Array(landColors.length).fill(-1);
  const augment = (n, seen) => {
    for (let l = 0; l < landColors.length; l++) {
      if (!seen[l] && landColors[l].some((col) => needs[n].includes(col))) {
        seen[l] = true;
        if (matchTo[l] === -1 || augment(matchTo[l], seen)) { matchTo[l] = n; return true; }
      }
    }
    return false;
  };
  for (let n = 0; n < needs.length; n++) {
    if (!augment(n, new Array(landColors.length).fill(false))) return false;
  }
  return true;
}

// Expand a spell's pips (+ any two-color hybrid pairs) into a list of color needs.
function needsFor(pips, hybrids) {
  const needs = [];
  for (const c in pips) for (let i = 0; i < pips[c]; i++) needs.push([c]);
  for (const pair of hybrids || []) needs.push(pair);
  return needs;
}

function castableOnCurve(lands, pips, mv, hybrids) {
  if (lands.length < mv) return false;                 // not enough lands (screw)
  const haveBasic = lands.some((l) => l.basic);
  // A "slow land" enters tapped unless you control two or more OTHER lands, so it's
  // untapped only once you have >=3 lands total; with <=2 it plays as a tapland. An
  // "untapBasic" land (enters tapped unless you control a basic) is untapped in any
  // game where a basic is actually on the battlefield — which the recommender can't
  // promise but the sim can see per game.
  const untapped = (l) => (!l.tapped || (l.untapBasic && haveBasic)) && (!l.slow || lands.length >= 3);
  if (!lands.some(untapped)) return false;             // only taplands -> a turn slow
  // A "check land" (needsBasic) makes its colors only while you control a basic; with
  // no basic in play it taps for colorless only, so it can't pay a colored pip (though
  // it still counts as a land toward the drop). Any one basic turns them all on.
  const colorsOf = (l) => (l.needsBasic && !haveBasic ? [] : l.colors);
  return canPayNeeds(needsFor(pips, hybrids), lands.map(colorsOf));
}

// How many extra turns past its cast turn we'll wait for a card to come online
// when measuring "average delay" — bounds the work and the screw/flood penalty.
const DELAY_CAP = 6;

/**
 * Simulate the whole deck once per trial and grade every spell from the same draws.
 * opts: { trials, onPlay, rng, drawCount, fetchCount }
 * @returns {{bySpell, overall, trials, keepRates, mulliganRate, delayBySpell}}
 *   keepRates: {7,6,5,4} fraction of games kept at each hand size;
 *   mulliganRate: fraction of games that took >=1 mulligan;
 *   delayBySpell: average turns past cast turn until castable (capped at DELAY_CAP).
 */
export function simulateDeck(spells, buildLands, deckSize, opts = {}) {
  const trials = opts.trials || 5000;
  const onPlay = opts.onPlay !== false;
  const drawCount = opts.drawCount || 0;
  const fetchCount = opts.fetchCount || 0;
  // Draw randomness. An explicit `rng` shares ONE stream across all trials (test
  // path). A numeric `seed` instead reseeds PER TRIAL, so trial t faces identical
  // luck across different candidate builds — true common random numbers, robust to
  // builds that mulligan at different rates (which consume different amounts of RNG
  // and would otherwise desync a single shared stream after the first divergent
  // trial). Default: unseeded Math.random.
  const sharedRng = opts.rng || (opts.seed == null ? Math.random : null);
  const template = buildDeck(buildLands, deckSize, drawCount, fetchCount);
  const success = {};
  const delaySum = {};
  for (const s of spells) { success[s.name] = 0; delaySum[s.name] = 0; }
  const keep = { 7: 0, 6: 0, 5: 0, 4: 0 };
  let mulliganed = 0;

  for (let t = 0; t < trials; t++) {
    const rng = sharedRng || mulberry32((opts.seed ^ Math.imul(t + 1, 0x9e3779b9)) >>> 0);
    const { hand, library, kept, mulls } = drawGame(template.slice(), rng);
    keep[kept] = (keep[kept] || 0) + 1;
    if (mulls > 0) mulliganed++;
    for (const s of spells) {
      const baseDraws = onPlay ? s.mv - 1 : s.mv;   // natural draws by the cast turn
      // Find the first extra turn (0 = on curve) the card becomes castable, drawing
      // one more card per extra turn. Most spells resolve at extra=0 and break out.
      let delay = -1;
      for (let extra = 0; extra <= DELAY_CAP; extra++) {
        const draws = baseDraws + extra;
        const lands = [];
        let digs = 0, fetches = 0;
        for (const c of hand) { if (isLand(c)) lands.push(c); else if (c === "draw") digs++; else if (c === "fetch") fetches++; }
        const lim = Math.min(draws, library.length);
        for (let i = 0; i < lim; i++) {
          const c = library[i];
          if (isLand(c)) lands.push(c); else if (c === "draw") digs++; else if (c === "fetch") fetches++;
        }
        // Each dig spell seen lets you look one card deeper for a land.
        for (let j = draws; j < draws + digs && j < library.length; j++) {
          if (isLand(library[j])) lands.push(library[j]);
        }
        // Each fetch/ramp spell pulls a land of the color you most need.
        resolveFetches(lands, fetches, s.pips, s.hybrids);
        if (castableOnCurve(lands, s.pips, s.mv, s.hybrids)) { delay = extra; break; }
      }
      if (delay === 0) success[s.name]++;       // castable on curve
      delaySum[s.name] += delay < 0 ? DELAY_CAP : delay;
    }
  }

  const bySpell = {};
  const delayBySpell = {};
  let overall = 1;
  for (const s of spells) {
    const p = success[s.name] / trials;
    bySpell[s.name] = p;
    delayBySpell[s.name] = delaySum[s.name] / trials;
    overall = Math.min(overall, p);
  }
  const keepRates = { 7: keep[7] / trials, 6: keep[6] / trials, 5: keep[5] / trials, 4: keep[4] / trials };
  return { bySpell, overall, trials, keepRates, mulliganRate: mulliganed / trials, delayBySpell };
}
