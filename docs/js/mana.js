// Mana-cost parsing and per-color casting constraints.
//
// Faithful port of core/requirements.py's parse_cost / mana_value /
// colors_in_cost / cost_constraints. Tokenises Scryfall mana strings
// (`{1}{W}{W}` -> one generic + two white):
//   * multi-digit generic costs like `{10}` read as 10;
//   * colorless `{C}` / snow `{S}` fold into generic pressure;
//   * variable `{X}` / `{Y}` / `{Z}` contribute 0;
//   * two-color hybrid `{W/U}` -> a hybrid pair (payable by either color);
//   * twobrid `{2/W}` -> generic 2; Phyrexian `{W/P}` -> generic 1.

import { COLORS } from "./colors.js";

const TOKEN_RE = /\{([^}]+)\}/g;
const HYBRID_RE = /^([WUBRG])\/([WUBRG])$/;  // two-color hybrid, e.g. W/U
const TWOBRID_RE = /^2\/[WUBRG]$/;            // monocolored hybrid, e.g. 2/W
const PHYREXIAN_RE = /^[WUBRG]\/P$/;          // Phyrexian, e.g. W/P

/**
 * Tokenise a mana cost into { generic, colored: {W,U,B,R,G}, hybrid }.
 * `hybrid` is a list of two-color pairs (e.g. ["W","U"] for {W/U}), each
 * payable by either color and contributing 1 to mana value.
 * @param {string} cost
 * @returns {{generic: number, colored: {W:number,U:number,B:number,R:number,G:number}, hybrid: string[][]}}
 */
export function parseCost(cost) {
  let generic = 0;
  const colored = {};
  for (const c of COLORS) colored[c] = 0;
  const hybrid = [];

  const str = cost || "";
  let match;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(str)) !== null) {
    const token = match[1];
    const hy = HYBRID_RE.exec(token);
    if (/^\d+$/.test(token)) {
      generic += parseInt(token, 10);
    } else if (token in colored) {
      colored[token] += 1;
    } else if (token === "C" || token === "S") {
      generic += 1; // colorless / snow -> generic pressure
    } else if (token === "X" || token === "Y" || token === "Z") {
      continue; // variable cost contributes 0
    } else if (hy) {
      hybrid.push([hy[1], hy[2]]); // two-color hybrid: payable by either color
    } else if (TWOBRID_RE.test(token)) {
      generic += 2; // {2/W}: pay 2 generic or one W
    } else if (PHYREXIAN_RE.test(token)) {
      generic += 1; // {W/P}: payable with life -> generic
    } else {
      generic += 1; // anything else -> generic
    }
  }
  return { generic, colored, hybrid };
}

/**
 * Total mana value of a cost (generic + colorless + all pips + hybrids).
 * @param {string} cost
 * @returns {number}
 */
export function manaValue(cost) {
  const { generic, colored, hybrid } = parseCost(cost);
  let sum = generic + hybrid.length;
  for (const c of COLORS) sum += colored[c];
  return sum;
}

/**
 * The distinct hard WUBRG symbols appearing in a mana cost (hybrids excluded).
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
  const { generic, colored, hybrid } = parseCost(cost);
  let mv = generic + hybrid.length;
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
