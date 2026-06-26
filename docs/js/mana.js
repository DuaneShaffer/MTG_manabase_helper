// Mana-cost parsing and per-color casting constraints.
//
// Faithful port of core/requirements.py's parse_cost / mana_value /
// colors_in_cost / cost_constraints. Tokenises Scryfall mana strings
// (`{1}{W}{W}` -> one generic + two white):
//   * multi-digit generic costs like `{10}` read as 10;
//   * colorless `{C}` / snow `{S}` fold into generic pressure;
//   * variable `{X}` / `{Y}` / `{Z}` contribute 0;
//   * hybrid / Phyrexian / anything else -> treated as generic.

import { COLORS } from "./colors.js";

const TOKEN_RE = /\{([^}]+)\}/g;

/**
 * Tokenise a mana cost into { generic, colored: {W,U,B,R,G} }.
 * @param {string} cost
 * @returns {{generic: number, colored: {W:number,U:number,B:number,R:number,G:number}}}
 */
export function parseCost(cost) {
  let generic = 0;
  const colored = {};
  for (const c of COLORS) colored[c] = 0;

  const str = cost || "";
  let match;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(str)) !== null) {
    const token = match[1];
    if (/^\d+$/.test(token)) {
      generic += parseInt(token, 10);
    } else if (token in colored) {
      colored[token] += 1;
    } else if (token === "C" || token === "S") {
      generic += 1; // colorless / snow -> generic pressure
    } else if (token === "X" || token === "Y" || token === "Z") {
      continue; // variable cost contributes 0
    } else {
      generic += 1; // hybrid / Phyrexian / anything else -> generic
    }
  }
  return { generic, colored };
}

/**
 * Total mana value of a cost (generic + colorless + all pips).
 * @param {string} cost
 * @returns {number}
 */
export function manaValue(cost) {
  const { generic, colored } = parseCost(cost);
  let sum = generic;
  for (const c of COLORS) sum += colored[c];
  return sum;
}

/**
 * The distinct WUBRG symbols appearing in a mana cost.
 * @param {string} cost
 * @returns {Set<string>}
 */
export function colorsInCost(cost) {
  const { colored } = parseCost(cost);
  const set = new Set();
  for (const c of COLORS) if (colored[c] > 0) set.add(c);
  return set;
}

/**
 * Per-color casting constraints for a cost.
 * Returns { [color]: { pips, mv, gold } } for each color the cost needs.
 * `gold` marks a multicolor card (>1 distinct color).
 * @param {string} cost
 * @returns {Object.<string, {pips:number, mv:number, gold:boolean}>}
 */
export function costConstraints(cost) {
  const { generic, colored } = parseCost(cost);
  let mv = generic;
  let distinct = 0;
  for (const c of COLORS) {
    mv += colored[c];
    if (colored[c] > 0) distinct += 1;
  }
  const gold = distinct > 1;
  const out = {};
  for (const c of COLORS) {
    if (colored[c] > 0) out[c] = { pips: colored[c], mv, gold };
  }
  return out;
}
