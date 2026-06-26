// Minimum colored-source requirements per color.
//
// Faithful port of core/requirements.py's sources_for / requirements_for_cards
// / requirements_for_costs. For each color a card needs, the live
// hypergeometric model gives the sources required; a multicolor (gold) card
// adds +1. Each color's requirement is the max across every card that needs it.

import { COLORS } from "./colors.js";
import { costConstraints } from "./mana.js";
import { sourcesNeeded } from "./hypergeometric.js";

const DEFAULT_DECK_SIZE = 60;

/**
 * Sources of one color needed for a single constraint (live hypergeometric).
 * A multicolor card adds +1 (Karsten's simultaneous-color approximation).
 * @param {number} pips
 * @param {number} mv
 * @param {boolean} gold
 * @param {number} [deckSize=60]
 * @param {?number} [threshold=null]
 * @returns {number}
 */
export function sourcesFor(pips, mv, gold, deckSize = DEFAULT_DECK_SIZE, threshold = null) {
  const base = sourcesNeeded(pips, mv, deckSize, null, threshold);
  return base + (gold ? 1 : 0);
}

/**
 * Per-color minimum sources for a list of cards ([{cost}] or [{mana_cost}]).
 * @param {Array<{cost?:string, mana_cost?:string}>} cards
 * @param {number} [deckSize=60]
 * @param {?number} [threshold=null]
 * @returns {{W:number,U:number,B:number,R:number,G:number}}
 */
export function requirementsForCards(cards, deckSize = DEFAULT_DECK_SIZE, threshold = null) {
  const requirements = {};
  for (const c of COLORS) requirements[c] = 0;

  for (const card of cards) {
    const cost = card.cost != null ? card.cost : card.mana_cost || "";
    const constraints = costConstraints(cost);
    for (const color of Object.keys(constraints)) {
      const { pips, mv, gold } = constraints[color];
      const need = sourcesFor(pips, mv, gold, deckSize, threshold);
      if (need > requirements[color]) requirements[color] = need;
    }
  }
  return requirements;
}

/**
 * Per-color minimum sources for an iterable of mana cost strings.
 * @param {string[]} costs
 * @param {number} [deckSize=60]
 * @param {?number} [threshold=null]
 * @returns {{W:number,U:number,B:number,R:number,G:number}}
 */
export function requirementsForCosts(costs, deckSize = DEFAULT_DECK_SIZE, threshold = null) {
  return requirementsForCards(
    costs.map((mc) => ({ cost: mc })),
    deckSize,
    threshold,
  );
}
