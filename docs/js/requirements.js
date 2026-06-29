// Minimum colored-source requirements per color.
//
// Faithful port of core/requirements.py's sources_for / requirements_for_cards
// / requirements_for_costs. For each color a card needs, the live
// hypergeometric model gives the sources required; a multicolor (gold) card
// adds +1. Each color's requirement is the max across every card that needs it.

import { COLORS } from "./colors.js";
import { parseCost, manaValue } from "./mana.js";
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
  // Two-color hybrid pips are payable by either color, so they don't force both.
  // Pass 1 computes hard (hybrid-free) requirements; pass 2 assigns each hybrid
  // pip to whichever of its two colors the deck already demands most (the
  // least-cost relaxation), folding it into that card's requirement.
  const parsed = [];
  const hard = {};
  for (const c of COLORS) hard[c] = 0;
  for (const card of cards) {
    const cost = card.cost != null ? card.cost : card.mana_cost || "";
    const { colored, hybrid } = parseCost(cost);
    const mv = manaValue(cost);
    parsed.push({ colored, hybrid, mv });
    const gold = COLORS.filter((c) => colored[c] > 0).length > 1;
    for (const c of COLORS) {
      if (colored[c] > 0) {
        const need = sourcesFor(colored[c], mv, gold, deckSize, threshold);
        if (need > hard[c]) hard[c] = need;
      }
    }
  }

  const requirements = {};
  for (const c of COLORS) requirements[c] = 0;
  for (const { colored, hybrid, mv } of parsed) {
    const pips = { ...colored };
    for (const pair of hybrid) {
      // Lean the hybrid on the color the deck already needs most; ties go to the
      // earlier WUBRG color for a deterministic result.
      let choice = pair[0];
      for (const c of pair) {
        if (hard[c] > hard[choice] || (hard[c] === hard[choice] && COLORS.indexOf(c) < COLORS.indexOf(choice))) {
          choice = c;
        }
      }
      pips[choice] = (pips[choice] || 0) + 1;
    }
    const active = COLORS.filter((c) => pips[c] > 0);
    const gold = active.length > 1;
    for (const c of active) {
      const need = sourcesFor(pips[c], mv, gold, deckSize, threshold);
      if (need > requirements[c]) requirements[c] = need;
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
