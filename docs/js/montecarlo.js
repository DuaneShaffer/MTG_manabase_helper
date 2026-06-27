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
// card deeper for a land (a cantrip cycling toward your next land). Casting
// timing and mana cost are idealized — it captures the smoothing direction, not
// exact sequencing.
//
// Other simplifications: London mulligan keeping 2–5 lands (≤3 mulls); on the
// play; one land drop per turn; a hand of only tapped lands can't cast on curve;
// ramp and scry-to-bottom policies aren't modelled.

const isLand = (c) => c !== null && typeof c === "object";

function shuffle(a, rng) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Deck template: a {colors, tapped, basic, needsBasic} token per land copy,
// "draw" per dig spell, null for inert filler.
function buildDeck(buildLands, deckSize, drawCount) {
  const deck = [];
  for (const l of buildLands) {
    for (let i = 0; i < l.count; i++) deck.push({ colors: l.colors, tapped: !!l.tapped, basic: !!l.basic, needsBasic: !!l.needsBasic });
  }
  for (let i = 0; i < drawCount; i++) deck.push("draw");
  for (let i = deck.length; i < deckSize; i++) deck.push(null);
  return deck;
}

// London mulligan: returns the kept hand + remaining library (in draw order).
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
      return { hand, library };
    }
    mulls++;
  }
}

// Can the colored pips be paid by distinct lands? (bipartite matching; duals ok)
function canPayColors(pips, landColors) {
  const need = [];
  for (const c in pips) for (let i = 0; i < pips[c]; i++) need.push(c);
  if (!need.length) return true;
  const matchTo = new Array(landColors.length).fill(-1);
  const augment = (n, seen) => {
    for (let l = 0; l < landColors.length; l++) {
      if (!seen[l] && landColors[l].includes(need[n])) {
        seen[l] = true;
        if (matchTo[l] === -1 || augment(matchTo[l], seen)) { matchTo[l] = n; return true; }
      }
    }
    return false;
  };
  for (let n = 0; n < need.length; n++) {
    if (!augment(n, new Array(landColors.length).fill(false))) return false;
  }
  return true;
}

function castableOnCurve(lands, pips, mv) {
  if (lands.length < mv) return false;                 // not enough lands (screw)
  if (!lands.some((l) => !l.tapped)) return false;     // only taplands -> a turn slow
  // A "check land" (needsBasic) makes its colors only while you control a basic; with
  // no basic in play it taps for colorless only, so it can't pay a colored pip (though
  // it still counts as a land toward the drop). Any one basic turns them all on.
  const haveBasic = lands.some((l) => l.basic);
  const colorsOf = (l) => (l.needsBasic && !haveBasic ? [] : l.colors);
  return canPayColors(pips, lands.map(colorsOf));
}

/**
 * Simulate the whole deck once per trial and grade every spell from the same draws.
 * opts: { trials, onPlay, rng, drawCount }
 * @returns {{bySpell: Object<string,number>, overall: number, trials: number}}
 */
export function simulateDeck(spells, buildLands, deckSize, opts = {}) {
  const trials = opts.trials || 5000;
  const onPlay = opts.onPlay !== false;
  const rng = opts.rng || Math.random;
  const drawCount = opts.drawCount || 0;
  const template = buildDeck(buildLands, deckSize, drawCount);
  const success = {};
  for (const s of spells) success[s.name] = 0;

  for (let t = 0; t < trials; t++) {
    const { hand, library } = drawGame(template.slice(), rng);
    for (const s of spells) {
      const draws = onPlay ? s.mv - 1 : s.mv;   // natural draws by the cast turn
      const lands = [];
      let digs = 0;
      for (const c of hand) { if (isLand(c)) lands.push(c); else if (c === "draw") digs++; }
      for (let i = 0; i < draws && i < library.length; i++) {
        const c = library[i];
        if (isLand(c)) lands.push(c); else if (c === "draw") digs++;
      }
      // Each dig spell seen lets you look one card deeper for a land.
      for (let j = draws; j < draws + digs && j < library.length; j++) {
        if (isLand(library[j])) lands.push(library[j]);
      }
      if (castableOnCurve(lands, s.pips, s.mv)) success[s.name]++;
    }
  }

  const bySpell = {};
  let overall = 1;
  for (const s of spells) {
    const p = success[s.name] / trials;
    bySpell[s.name] = p;
    overall = Math.min(overall, p);
  }
  return { bySpell, overall, trials };
}
