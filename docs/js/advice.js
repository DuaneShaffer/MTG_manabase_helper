// Actionable manabase advice.
//
// The recommender holds the land count to the recommended target (optimize.js) and,
// when that cap can't cover every color, gives on the color the deck leans on least.
// This module turns that outcome into plain-language guidance: what got covered, what
// gave, and the concrete levers to change it. Pure and exported so it can be unit-
// tested and reused by the app. App-only — no Python mirror, like optimize.js.

import { COLORS, COLOR_NAMES } from "./colors.js";

// Pick the option a player should read coverage from: the one that covers the most
// (smallest total shortfall), breaking ties toward fewer lands.
function bestCoverage(options) {
  const short = (o) => COLORS.reduce((s, c) => s + (o.rec.shortfall?.[c] || 0), 0);
  return [...options].sort((a, b) => short(a) - short(b) || a.rec.total - b.rec.total)[0];
}

/**
 * Generate manabase advice from the recommender's options.
 * @param {Array<{label:string, rec:{sources:Object, shortfall:Object, total:number, taplands:number}}>} options
 * @param {Object} ctx
 * @param {Object} ctx.requirements  per-color source minimums
 * @param {number} ctx.landTarget    the recommended (and capped) land count
 * @param {Object} [ctx.demand]      per-color total colored pips (how much the deck leans on each color)
 * @param {Object} [ctx.colorInfo]   per-color { cards:number, driver:{name,pips,qty} } — the card forcing the requirement
 * @returns {{status:string, headline:string, detail:string[], levers:string[]}}
 */
export function manabaseAdvice(options, ctx) {
  const { requirements = {}, landTarget = 0, demand = {}, colorInfo = {} } = ctx || {};
  if (!options || !options.length) {
    return { status: "none", headline: "No build to assess yet.", detail: [], levers: [] };
  }

  const best = bestCoverage(options);
  const shortColors = COLORS.filter((c) => (best.rec.shortfall?.[c] || 0) > 0);
  const name = (c) => COLOR_NAMES[c] || c;

  // The leanest build that still covers every color, if any option does.
  const fullyCovering = options.filter((o) => COLORS.every((c) => !(o.rec.shortfall?.[c] > 0)));
  const minCover = fullyCovering.length ? Math.min(...fullyCovering.map((o) => o.rec.total)) : null;

  // ---- Everything covered ----------------------------------------------------
  if (!shortColors.length) {
    if (minCover != null && minCover < landTarget) {
      const slack = landTarget - minCover;
      return {
        status: "covered-slack",
        headline: "Every color's covered.",
        detail: [`Your ${landTarget} lands clear every color's source minimum with room to spare — covering your colors alone would take as few as ${minCover} lands.`],
        levers: [`The other ${slack} land${slack === 1 ? "" : "s"} ${slack === 1 ? "is" : "are"} about hitting your land drops on curve (mana-screw insurance), not color fixing — ${landTarget} is set by your curve, so keep it unless you're flooding out.`],
      };
    }
    return {
      status: "covered",
      headline: "Every color's covered.",
      detail: [`Your ${landTarget} lands meet every color's source requirement.`],
      levers: [],
    };
  }

  // ---- One or more colors gave under the cap ---------------------------------
  // Order the shortfalls lightest-demand first — those are the ones we chose to give on.
  shortColors.sort((a, b) => (demand[a] || 0) - (demand[b] || 0));

  // The lightest needed color (fewest total pips) — the one a demand-driven
  // shortfall would land on.
  const lowestDemand = COLORS.filter((c) => (requirements[c] || 0) > 0)
    .sort((a, b) => (demand[a] || 0) - (demand[b] || 0))[0];

  if (shortColors.length === 1) {
    const c = shortColors[0];
    const req = requirements[c] || 0;
    const have = best.rec.sources[c] || 0;
    const deficit = best.rec.shortfall[c];
    const info = colorInfo[c] || {};
    const driver = info.driver;
    const cards = info.cards;
    const lc = name(c).toLowerCase();
    // Two distinct causes: a single color needing MORE sources than the whole land
    // count (structural — a land makes at most one source of a color), versus a
    // color that lost the competition for a limited number of land slots.
    const structural = req > landTarget;

    const detail = [];
    if (structural) {
      detail.push(
        `${name(c)} wants ${req} sources, but a ${landTarget}-land deck can field at most ${landTarget} of any one color — so the build tops out at ${have}.` +
        (driver ? ` That's ${driver.name}'s ${driver.pips} ${lc} pips setting the bar.` : ""),
      );
    } else {
      detail.push(
        `At ${landTarget} lands, ${name(c)} is the one color you can't fully cover: the model wants ${req} ${lc} sources` +
        (driver ? ` (for ${driver.name}, ${driver.pips} pips)` : "") + `, and the best ${landTarget}-land build reaches ${have}.`,
      );
      if (c === lowestDemand && cards != null) {
        detail.push(`${name(c)} is the color your deck leans on least — only ${cards} card${cards === 1 ? "" : "s"} need${cards === 1 ? "s" : ""} it — so the build gives there rather than running extra lands.`);
      }
    }

    const levers = [];
    levers.push(`Add ~${deficit} more land${deficit === 1 ? "" : "s"} (≈${landTarget + deficit} total) to reach ${req} ${lc} sources.`);
    levers.push(`Or keep ${landTarget} and accept it — ${have} of ${req} sources means ${driver ? driver.name : `your ${lc} cards`} comes down a turn late now and then.`);
    if (driver && (driver.qty || 0) <= 4 && driver.pips >= 2) {
      levers.push(`Or cut ${driver.name} — its ${driver.pips} ${lc} pips are what pushes the requirement to ${req}.`);
    }
    return { status: "short-one", headline: `${name(c)} gives a little at ${landTarget} lands.`, detail, levers };
  }

  // Several colors short — the deck is ambitious for the land count.
  const list = shortColors.map((c) => `${name(c)} (${best.rec.sources[c] || 0}/${requirements[c] || 0})`);
  const maxDeficit = Math.max(...shortColors.map((c) => best.rec.shortfall[c]));
  const detail = [
    `Your colors are ambitious for ${landTarget} lands: ${list.join(", ")} all come up short. The build fully funds your heaviest colors and gives on the lighter ones.`,
  ];
  const levers = [
    `Add lands — roughly ${landTarget + maxDeficit} would cover everything.`,
    `Or commit to two main colors and treat the third as a light splash.`,
    `Or favor single-pip cards in your lighter colors to lower what they demand.`,
  ];
  return { status: "short-many", headline: `Several colors give at ${landTarget} lands.`, detail, levers };
}
