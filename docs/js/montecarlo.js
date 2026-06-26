// Monte-Carlo castability validator.
//
// The closed-form grade (hypergeometric) conditions on hitting your land drops —
// it measures colour reliability, not raw mana screw. This simulator instead
// plays out real games: shuffle, London-mulligan to a keepable hand, draw to the
// turn you'd cast each card, and check whether you can actually cast it on curve.
// The resulting probability folds in BOTH not-enough-lands and wrong-colours.
//
// Simplifications (documented honestly):
//   * Mulligan: keep the first hand with 2–5 lands, up to 3 mulligans, then keep;
//     London bottoming sheds toward ~3 lands.
//   * On the play (no turn-1 draw). One land drop per turn.
//   * Tapped lands: assumed playable early enough to be online by the cast turn,
//     EXCEPT a hand with only tapped lands can't cast on curve (the last drop is
//     tapped). Fetch/again-style effects aren't modelled.
//   * Nonland cards are inert filler (they don't ramp or fix).

function shuffle(a, rng) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Deck template: a token {colors, tapped} per land copy, null per nonland.
function buildDeck(buildLands, deckSize) {
  const deck = [];
  for (const l of buildLands) {
    for (let i = 0; i < l.count; i++) deck.push({ colors: l.colors, tapped: !!l.tapped });
  }
  for (let i = deck.length; i < deckSize; i++) deck.push(null);
  return deck;
}

// London mulligan: returns the kept hand + remaining library (in draw order).
function drawGame(deck, rng) {
  let mulls = 0;
  while (true) {
    shuffle(deck, rng);
    const hand = deck.slice(0, 7);
    const nLands = hand.filter(Boolean).length;
    if ((nLands >= 2 && nLands <= 5) || mulls >= 3) {
      const library = deck.slice(7);
      // Bottom `mulls` cards, shedding toward ~3 lands.
      for (let i = 0; i < mulls; i++) {
        const lands = hand.filter(Boolean).length;
        let idx = lands > 3 ? hand.findIndex(Boolean) : hand.findIndex((c) => !c);
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
  return canPayColors(pips, lands.map((l) => l.colors));
}

/**
 * Simulate the whole deck once per trial and grade every spell from the same draws.
 * @returns {{bySpell: Object<string,number>, overall: number, trials: number}}
 */
export function simulateDeck(spells, buildLands, deckSize, opts = {}) {
  const trials = opts.trials || 5000;
  const onPlay = opts.onPlay !== false;
  const rng = opts.rng || Math.random;  // tests pass a seeded RNG for determinism
  const template = buildDeck(buildLands, deckSize);
  const success = {};
  for (const s of spells) success[s.name] = 0;

  for (let t = 0; t < trials; t++) {
    const { hand, library } = drawGame(template.slice(), rng);
    for (const s of spells) {
      const draws = onPlay ? s.mv - 1 : s.mv;          // cards drawn by the cast turn
      const lands = [];
      for (const c of hand) if (c) lands.push(c);
      for (let i = 0; i < draws && i < library.length; i++) if (library[i]) lands.push(library[i]);
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
