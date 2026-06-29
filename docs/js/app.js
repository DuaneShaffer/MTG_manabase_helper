import { COLORS, COLOR_NAMES } from "./colors.js";
import { costConstraints, manaValue, parseCost } from "./mana.js";
import { requirementsForCards } from "./requirements.js";
import { castableProbability, multivariateCastable, grade, drawOddsByTurn } from "./hypergeometric.js";
import { recommend as recommendManabase, recommendLandCount } from "./recommend.js";
import { optimizeManabase, battleTested, OBJECTIVES, setLandPopularity } from "./optimize.js";
import { manabaseAdvice } from "./advice.js";
import { simulateDeck } from "./montecarlo.js";
import { parseDeckText, deckEntries, cardNames } from "./decklist.js";
import { loadLands, loadMeta, resolveDeck, loadExampleDeck, loadLandPopularity } from "./data.js";

const STORAGE_KEY = "mtg_manabase_deck";

const state = {
  lands: [],
  counts: {},
  requirements: { W: 0, U: 0, B: 0, R: 0, G: 0 },
  spells: [],          // colored deck spells for grading
  deckCards: [],       // nonland deck cards {name, mv} for the curve
  deckSize: 60,
  landTarget: null,
  threshold: null,     // null = Karsten sliding; else flat float
  previewCut: false,   // "Preview the cut": draw figures simulate the leaner build (real build untouched)
  suggest: null,       // fixer glow: null = auto (glow while a color is short); true/false = user override
  raresOnly: false,
  search: "",
  sort: "name",
  landMode: "all",     // suggested | relevant | mycolors | utility | all
  suggestedLands: null,    // Set of land names the recommender would reach for (null until computed)
  tiles: new Map(),    // land name -> { el, land, numEl }
  spellCells: new Map(),
  lastRec: null,
  recOptions: [],          // computed manabase options shown in the drawer
  lastImportedDeck: null,  // deck text whose lands were loaded into the build
  avgMV: 3,
  smoothCards: [],     // [{name, qty}] CHEAP (<=2 MV) draw/ramp — trims the land count + helps the sim
  smoothOverrides: {}, // name -> copies counted toward the land target & sim
  digCards: [],        // [{name, qty}] mid-cost (3 MV) card advantage — helps the sim, NOT the land count
  digOverrides: {},    // name -> copies counted toward the sim
  costOverrides: {},   // name -> mana-cost STRING to use instead of the printed cost (kicker/X/free spells)
  resolvedCards: [],   // last analyzed deck's resolved Scryfall cards (for cost-override recompute)
  qtyByName: {},       // name -> copies in the analyzed deck
  conditionsPresent: new Set(),  // condition keywords across the land pool
  conditionsActive: new Set(),   // conditions the loaded deck satisfies
};

const COND_THRESHOLD = 6;  // a conditional land "turns on" at this many matching deck cards
const SMOOTH_MAX_MV = 2;   // <=2 MV draw/ramp smooths your early drops; 3 MV is "card advantage" instead

// Cheap smoothers feed the recommended-land formula (they let you run fewer lands).
function smoothCount() {
  return state.smoothCards.reduce(
    (s, c) => s + (state.smoothOverrides[c.name] ?? c.qty), 0);
}
// Mid-cost diggers don't change the land count, but in-game they dig toward the
// lands your expensive spells need — so they feed the simulation only.
function digCount() {
  return state.digCards.reduce(
    (s, c) => s + (state.digOverrides[c.name] ?? c.qty), 0);
}
// Of the counted draw/ramp cards, how many are land-fetchers (Cultivate, land
// tutors). The sim resolves these to the scarcest needed color rather than a
// generic dig. Respects the same per-card override counts as smoothCount/digCount.
function fetchCount() {
  let n = 0;
  for (const c of state.smoothCards) if (c.fetch) n += (state.smoothOverrides[c.name] ?? c.qty);
  for (const c of state.digCards) if (c.fetch) n += (state.digOverrides[c.name] ?? c.qty);
  return n;
}

const $ = (s) => document.querySelector(s);
const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };
// A land if "Land" is among its *front* face's card types (left of the subtype
// dash, before the "//" face split). A transform DFC whose back is a land
// ("Artifact // Land — Cave") is a spell you cast, not a land you play.
const isLandType = (type) => (type || "").split("//")[0].split("—")[0].includes("Land");

const idle = (fn) =>
  (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 1500 }) : setTimeout(() => fn(null), 150));

// Progressive image sharpening: thumbnails (small) load first; hi-res upgrades
// adapt to the connection. Fast links sharpen everything in the background; slow
// links (or Data Saver) only sharpen what you scroll/hover to. Hover always works.
const sharpen = {
  mode: null,        // "hover" | "scroll" | "eager"
  io: null,
  pending: [],
  init() {
    if (this.mode) return;
    const c = navigator.connection || {};
    if (!("IntersectionObserver" in window) || c.saveData) this.mode = "hover";
    else if (c.effectiveType === "2g" || c.effectiveType === "slow-2g") this.mode = "hover";
    else if (c.effectiveType === "4g") this.mode = "eager";
    else this.mode = "scroll";  // 3g or unknown: sharpen on scroll, no bulk prefetch
    if (this.mode !== "hover") {
      this.io = new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) { this.upgrade(e.target); this.io.unobserve(e.target); }
      }, { rootMargin: this.mode === "eager" ? "800px" : "250px" });
    }
  },
  register(img) {
    this.init();
    if (this.mode === "hover") return;
    this.io.observe(img);
    if (this.mode === "eager") this.pending.push(img);
  },
  upgrade(img) {
    if (img.dataset.hi || !img.dataset.hiUrl) return;
    img.dataset.hi = "1";
    img.src = img.dataset.hiUrl;
  },
  // Background-fill the rest, keeping at most a few hi-res fetches in flight so a
  // weak link is never saturated (each finishes before the next starts).
  backfill() {
    if (this.mode !== "eager") return;
    let inflight = 0;
    const MAX = 4;
    const pump = () => {
      while (inflight < MAX && this.pending.length) {
        const img = this.pending.shift();
        if (img.dataset.hi) continue;
        inflight++;
        const done = () => { inflight--; pump(); };
        img.addEventListener("load", done, { once: true });
        img.addEventListener("error", done, { once: true });
        this.upgrade(img);
      }
    };
    idle(pump);
  },
};

/* ---------- tally ---------- */
function tally() {
  const t = { W: 0, U: 0, B: 0, R: 0, G: 0, total: 0 };
  for (const land of state.lands) {
    const n = state.counts[land.name] || 0;
    if (!n) continue;
    t.total += n;
    for (const c of land.colors) t[c] += n;
  }
  return t;
}

function deficitColors() {
  const t = tally();
  return new Set(COLORS.filter((c) => t[c] < state.requirements[c]));
}

/* ---------- dashboard ---------- */
function buildDashboard() {
  const wrap = $("#colors");
  wrap.innerHTML = "";
  for (const c of COLORS) {
    const row = el("div", "color-row");
    row.dataset.c = c;
    row.innerHTML = `
      <div class="pip" data-c="${c}">${c}</div>
      <div class="bar-wrap">
        <div class="bar"><div class="bar-fill"></div><div class="bar-req"></div></div>
      </div>
      <div class="count"><span class="cur">0</span><span class="req"></span></div>`;
    wrap.appendChild(row);
  }
}

function refreshDashboard() {
  const t = tally();
  for (const c of COLORS) {
    const row = document.querySelector(`.color-row[data-c="${c}"]`);
    const req = state.requirements[c];
    const cur = t[c];
    const scale = Math.max(req, cur, 1);
    row.querySelector(".bar-fill").style.right = (100 - (cur / scale) * 100) + "%";
    row.querySelector(".bar-req").style.left = req > 0 ? (req / scale) * 100 + "%" : "-10px";
    row.querySelector(".cur").textContent = cur;
    row.querySelector(".req").textContent = req > 0 ? " / " + req : "";
    row.classList.toggle("met", req > 0 && cur >= req);
    row.classList.toggle("short", req > 0 && cur < req);
  }
  $("#totalLands").textContent = t.total;
}

/* ---------- land grid (built once, filtered by visibility) ---------- */
function tileFor(land) {
  const tile = el("div", "tile");
  const dots = el("div", "colors-dot");
  for (const c of land.colors) { const i = el("i"); i.dataset.c = c; dots.appendChild(i); }
  const ph = el("div", "ph"); ph.textContent = land.name;
  const img = el("img");
  img.alt = land.name; img.loading = "lazy"; img.decoding = "async";
  img.addEventListener("load", () => img.classList.add("loaded"));
  if (land.image) img.src = land.image;
  // Progressive sharpening: hover always upgrades; the sharpener also upgrades on
  // scroll / in the background depending on the connection.
  if (land.image_hi && land.image_hi !== land.image) {
    img.dataset.hiUrl = land.image_hi;
    tile.addEventListener("mouseenter", () => sharpen.upgrade(img), { once: true });
    sharpen.register(img);
  }
  const stepper = el("div", "stepper");
  const minus = el("button", "step-btn"); minus.textContent = "−";
  const numEl = el("span", "step-n"); numEl.textContent = state.counts[land.name] || 0;
  const plus = el("button", "step-btn"); plus.textContent = "+";
  minus.addEventListener("click", () => changeCount(land, -1));
  plus.addEventListener("click", () => changeCount(land, 1));
  stepper.append(minus, numEl, plus);
  tile.append(ph, img, dots, stepper);
  return { tile, numEl };
}

function buildGrid() {
  const grid = $("#grid");
  grid.innerHTML = "";
  state.tiles = new Map();
  const frag = document.createDocumentFragment();
  for (const land of state.lands) {
    const { tile, numEl } = tileFor(land);
    state.tiles.set(land.name, { el: tile, land, numEl });
    applyTileState(land, tile);
    frag.appendChild(tile);
  }
  grid.appendChild(frag);
  applySort();
  applyVisibility();
  markFixers();
  sharpen.backfill();  // on fast connections, fill in hi-res art in the background
}

function deckColors() {
  return new Set(COLORS.filter((c) => state.requirements[c] > 0));
}

// Which lands the "Show" mode allows. `dc` = the deck's colors (precomputed).
function passesMode(land, dc) {
  const mode = state.landMode;
  if (mode === "utility") return land.colors.length === 0;
  if (mode === "suggested") {
    // The recommender's picks for this deck. Always keep lands you've already
    // added so toggling here never hides part of your own build. Until the
    // optimizer returns (or if it can't load), fall back to "relevant".
    if (state.suggestedLands) return state.suggestedLands.has(land.name) || (state.counts[land.name] || 0) > 0;
    if (dc.size) return land.colors.some((c) => dc.has(c)) || land.colors.length === 0;
    return true;
  }
  if ((mode === "relevant" || mode === "mycolors") && dc.size) {
    const onColor = land.colors.some((c) => dc.has(c));
    if (mode === "mycolors") return onColor;
    return onColor || land.colors.length === 0;  // relevant = on-color + utility
  }
  return true;  // "all", or a color mode with no deck loaded yet
}

function isVisible(land, dc) {
  if (state.search && !land.name.toLowerCase().includes(state.search)) return false;
  if (state.raresOnly && land.rarity !== "rare" && land.rarity !== "mythic") return false;
  return passesMode(land, dc);
}

function applyVisibility() {
  const dc = deckColors();
  let n = 0;
  for (const { el: tile, land } of state.tiles.values()) {
    const vis = isVisible(land, dc);
    tile.style.display = vis ? "" : "none";
    if (vis) n++;
  }
  $("#gridCount").textContent = `${n} land${n === 1 ? "" : "s"}`;
  $("#gridEmpty").hidden = n > 0;
  $("#gridEmpty").textContent = n ? "" : "No lands match the current filters.";
}

function setLandMode(mode) {
  state.landMode = mode;
  for (const b of document.querySelectorAll("#landMode .seg-btn")) {
    b.classList.toggle("on", b.dataset.mode === mode);
  }
  applyVisibility();
}

const _colorRank = (l) => l.colors.map((c) => COLORS.indexOf(c)).sort().join("");
const SORTERS = {
  name: (a, b) => a.name.localeCompare(b.name),
  color: (a, b) => _colorRank(a).localeCompare(_colorRank(b)) || a.name.localeCompare(b.name),
  fixing: (a, b) => b.colors.length - a.colors.length || a.name.localeCompare(b.name),
};

function applySort() {
  const grid = $("#grid");
  const sorted = [...state.lands].sort(SORTERS[state.sort] || SORTERS.name);
  for (const land of sorted) {
    const e = state.tiles.get(land.name);
    if (e) grid.appendChild(e.el);  // re-append reorders without rebuilding
  }
}

function changeCount(land, delta) {
  const entry = state.tiles.get(land.name);
  const cur = state.counts[land.name] || 0;
  const next = cur + delta;
  if (next < 0 || (!land.basic && next > 4)) return;
  state.counts[land.name] = next;
  entry.numEl.textContent = next;
  state.previewCut = false;   // editing the build invalidates the previewed cut basis
  applyTileState(land, entry.el);
  refreshDashboard();
  refreshBuildList();
  markFixers();  // deficit highlight updates as the build changes
  gradeBuild();
}

function applyTileState(land, tile) {
  tile.classList.toggle("added", (state.counts[land.name] || 0) > 0);
}

function markFixers() {
  const deficit = deficitColors();
  // Auto-engage while a color is short; the toggle is only an explicit override.
  const on = state.suggest === null ? deficit.size > 0 : state.suggest;
  const need = on ? deficit : null;
  for (const { el: tile, land } of state.tiles.values()) {
    tile.classList.toggle("fixer", !!need && land.colors.some((c) => need.has(c)));
  }
  // Reflect the effective state on the toggle so an auto-on glow reads as active
  // (and clickable to dismiss), not as an untouched control.
  const toggle = $("#suggestToggle");
  if (toggle) toggle.classList.toggle("on", on && deficit.size > 0);
}

function syncCountsToTiles() {
  for (const { el: tile, land, numEl } of state.tiles.values()) {
    numEl.textContent = state.counts[land.name] || 0;
    applyTileState(land, tile);
  }
  refreshBuildList();
}

/* ---------- "Your build" list (current manabase, editable in place) ---------- */
function refreshBuildList() {
  const wrap = $("#buildWrap");
  const list = $("#buildList");
  if (!wrap || !list) return;
  const byName = new Map(state.lands.map((l) => [l.name, l]));
  const rows = Object.entries(state.counts)
    .filter(([, n]) => n > 0)
    .map(([name, n]) => ({ land: byName.get(name), n }))
    .filter((r) => r.land)
    .sort((a, b) => _colorRank(a.land).localeCompare(_colorRank(b.land)) || a.land.name.localeCompare(b.land.name));

  // Show the section once there's a deck to tune (even at 0 lands, as an invitation)
  // or any land already added by hand.
  const total = rows.reduce((s, r) => s + r.n, 0);
  wrap.hidden = !(state.spells.length || total > 0);

  list.innerHTML = "";
  if (!rows.length) {
    const empty = el("div", "build-empty");
    empty.textContent = "No lands yet. Add them from the grid, or press Build manabase.";
    list.appendChild(empty);
    $("#buildDilution").textContent = "";
    return;
  }
  for (const { land, n } of rows) {
    const row = el("div", "build-row");
    const c = el("span", "b-c"); c.textContent = n;
    const name = el("span", "b-n"); name.textContent = land.name; name.title = land.name;
    const dots = el("span", "b-d");
    for (const col of land.colors) { const i = el("i"); i.dataset.c = col; dots.appendChild(i); }
    const step = el("div", "b-step");
    const minus = el("button", "step-btn b-mini"); minus.textContent = "−";
    minus.setAttribute("aria-label", `Remove one ${land.name}`);
    const plus = el("button", "step-btn b-mini"); plus.textContent = "+";
    plus.setAttribute("aria-label", `Add one ${land.name}`);
    minus.addEventListener("click", () => changeCount(land, -1));
    plus.addEventListener("click", () => changeCount(land, 1));
    step.append(minus, plus);
    row.append(c, name, dots, step);
    list.appendChild(row);
  }
  // Dilution: flag lands that make no colored mana (utility/colorless) so a base
  // padded with them is visible at a glance.
  const colored = rows.filter((r) => r.land.colors.length).reduce((s, r) => s + r.n, 0);
  $("#buildDilution").textContent = colored < total ? `${colored} colored · ${total} lands` : `${total} lands`;
}

/* ---------- conditional fixing (Avengers Tower etc.) ---------- */
function applyConditions(cards, qtyByName) {
  const counts = {};
  const condColorsNeeded = {};   // condition -> colors its matching-type spells demand
  for (const cond of state.conditionsPresent) { counts[cond] = 0; condColorsNeeded[cond] = new Set(); }
  for (const c of cards) {
    if (isLandType(c.type)) continue;
    const t = (c.type || "").toLowerCase();
    const q = qtyByName[c.name] || 0;
    const cols = Object.keys(costConstraints(c.cost || ""));  // colored pips this spell needs
    for (const cond of state.conditionsPresent) {
      // a condition like "instant or sorcery" matches a card of either type
      if (cond.split(" or ").some((p) => t.includes(p))) {
        counts[cond] += q;
        for (const col of cols) condColorsNeeded[cond].add(col);
      }
    }
  }
  state.conditionsActive = new Set(
    [...state.conditionsPresent].filter((cond) => counts[cond] >= COND_THRESHOLD));
  // Set each conditional land's effective colors and refresh its tile. A conditional
  // land (Cavern of Souls, Great Hall) only makes colored mana for spells matching its
  // condition — creatures, or instants & sorceries — so credit its colors only for the
  // colors those matching-type spells actually demand. Otherwise a creature land in a
  // W/B/R deck reads as a full rainbow, inventing off-color sources it can never cast.
  for (const land of state.lands) {
    if (!land.condition) continue;
    const allow = condColorsNeeded[land.condition] || new Set();
    const eff = state.conditionsActive.has(land.condition)
      ? [...new Set([...land.baseColors, ...(land.condColors || []).filter((c) => allow.has(c))])]
      : land.baseColors;
    if ((land.colors || []).join() !== eff.join()) {
      land.colors = eff.slice();
      refreshTileDots(land);
    }
  }
  // Deck-aware tapped: a "Roads" land (untapWhen "mount or vehicle") enters untapped
  // only when the deck runs enough of that permanent; otherwise it's a tapland. The
  // recommender, sim, and tile all read land.tapped, so this flows everywhere.
  for (const land of state.lands) {
    if (!land.untapWhen) continue;
    land.tapped = state.conditionsActive.has(land.untapWhen) ? false : land.baseTapped;
  }
}

function refreshTileDots(land) {
  const entry = state.tiles.get(land.name);
  if (!entry) return;
  const dots = entry.el.querySelector(".colors-dot");
  if (!dots) return;
  dots.innerHTML = "";
  for (const c of land.colors) { const i = el("i"); i.dataset.c = c; dots.appendChild(i); }
}

/* ---------- recommended-land panel ---------- */
function updateLandPanel() {
  const row = $("#recTargetRow");
  // Flow-aware primary CTA: echo the target in the Build button so it self-explains.
  const recBtn = $("#recommendBtn");
  if (recBtn) recBtn.textContent = state.landTarget ? `Build ~${state.landTarget} lands` : "Build manabase";
  if (!state.landTarget) { row.hidden = true; return; }
  row.hidden = false;
  $("#recTarget").textContent = "~" + state.landTarget;
  const base = recommendLandCount(state.avgMV, state.deckSize, 0);
  const delta = base - state.landTarget;
  const sc = smoothCount();
  const dc = digCount();
  let why = `Karsten's curve for an average mana value of ${state.avgMV.toFixed(1)}`;
  if (sc && delta > 0) why += `, minus ~${delta} for ${sc} cheap (≤${SMOOTH_MAX_MV} MV) draw/ramp card${sc === 1 ? "" : "s"} (↻)`;
  why += `. Aggro leans to the low end, control to the high end.`;
  if (dc) why += ` ${dc} mid-cost card-advantage spell${dc === 1 ? "" : "s"} (+) don't lower this count — they're too slow to fix your early drops — but they dig toward the lands your expensive spells need, which the simulation rewards.`;
  $("#landWhyNote").textContent = why;
}

/* ---------- draw/ramp tweak popover (handles both cheap smoothers and diggers) ---------- */
let _smoothPopName = null;
let _smoothPopKind = "smooth";
function openSmoothPop(name, qty, anchorEl, kind) {
  _smoothPopName = name;
  _smoothPopKind = kind === "dig" ? "dig" : "smooth";
  const pop = $("#smoothPop");
  const ov = _smoothPopKind === "dig" ? state.digOverrides : state.smoothOverrides;
  $("#smoothPopTitle").textContent = name;
  $("#smoothPopLabel").textContent = _smoothPopKind === "dig" ? "Count as card advantage" : "Count as draw/ramp";
  $("#smoothCountVal").textContent = ov[name] ?? qty;
  const cops = `cop${qty === 1 ? "y" : "ies"}`;
  $("#smoothOf").textContent = _smoothPopKind === "dig"
    ? `of ${qty} ${cops} dig toward lands in the simulation (they don't change your land count).`
    : `of ${qty} ${cops} count toward the land target & the simulation.`;
  const r = anchorEl.getBoundingClientRect();
  pop.style.left = Math.min(window.innerWidth - 224, Math.max(6, r.left - 100)) + "px";
  pop.style.top = (r.bottom + 6) + "px";
  pop.hidden = false;
}
function changeSmooth(delta) {
  const list = _smoothPopKind === "dig" ? state.digCards : state.smoothCards;
  const ov = _smoothPopKind === "dig" ? state.digOverrides : state.smoothOverrides;
  const card = list.find((c) => c.name === _smoothPopName);
  if (!card) return;
  const cur = ov[card.name] ?? card.qty;
  const next = Math.max(0, Math.min(card.qty, cur + delta));
  ov[card.name] = next;
  $("#smoothCountVal").textContent = next;
  // Only cheap smoothers move the land target; diggers affect the sim only.
  if (_smoothPopKind === "smooth") {
    state.landTarget = recommendLandCount(state.avgMV, state.deckSize, smoothCount());
    updateLandPanel();
  }
}

/* ---------- cost-override popover ---------- */
let _costPopCard = null;
function openCostPop(spell, anchorEl) {
  // The resolved card carries the printed cost; spell.name keys the override.
  _costPopCard = (state.resolvedCards || []).find((c) => c.name === spell.name) || { name: spell.name, cost: "" };
  const pop = $("#costPop");
  $("#costPopTitle").textContent = spell.name;
  const input = $("#costPopInput");
  input.value = state.costOverrides[spell.name] ?? "";
  input.placeholder = _costPopCard.cost || "{1}{R}";
  renderCostPreview();
  const r = anchorEl.getBoundingClientRect();
  pop.style.left = Math.min(window.innerWidth - 244, Math.max(6, r.left - 110)) + "px";
  pop.style.top = (r.bottom + 6) + "px";
  pop.hidden = false;
  input.focus();
  input.select();
}
// Live preview of what the entered cost parses to (MV + colored pips), so a typo
// is obvious before you apply it.
function renderCostPreview() {
  const raw = $("#costPopInput").value.trim();
  const box = $("#costPopPreview");
  const printed = _costPopCard?.cost || "";
  const cost = raw || printed;
  if (!cost) { box.textContent = "Printed cost unknown — enter one to override."; box.dataset.warn = "1"; return; }
  const mv = manaValue(cost);
  const { colored, hybrid } = parseCost(cost);
  const pips = [];
  for (const c of COLORS) for (let i = 0; i < colored[c]; i++) pips.push(c);
  for (const pair of hybrid) pips.push(pair.join("/"));
  const sym = pips.length ? pips.map((p) => `{${p}}`).join("") : "no colored pips";
  box.dataset.warn = "";
  box.textContent = `${raw ? "Override" : "Printed"}: MV ${mv} · ${sym}`;
}
function applyCostPop() {
  if (!_costPopCard) return;
  const raw = $("#costPopInput").value.trim();
  if (raw) state.costOverrides[_costPopCard.name] = raw;
  else delete state.costOverrides[_costPopCard.name];
  $("#costPop").hidden = true;
  recomputeFromCosts();
}
function resetCostPop() {
  if (!_costPopCard) return;
  delete state.costOverrides[_costPopCard.name];
  $("#costPop").hidden = true;
  recomputeFromCosts();
}

/* ---------- floating card preview ---------- */
function showPreview(src, x, y) {
  if (!src) return;
  const cp = $("#cardPreview");
  cp.querySelector("img").src = src;
  cp.hidden = false;
  positionPreview(x, y);
}
function positionPreview(x, y) {
  const cp = $("#cardPreview");
  const w = 240, h = 336;
  let left = x + 18;
  if (left + w > window.innerWidth) left = x - w - 18;
  const top = Math.max(8, Math.min(window.innerHeight - h - 8, y - h / 2));
  cp.style.left = left + "px";
  cp.style.top = top + "px";
}
function hidePreview() { $("#cardPreview").hidden = true; }

/* ---------- modal drawers (focus return + Esc + backdrop close) ---------- */
let _drawerOpener = null;
function openDrawer(drawerEl) {
  _drawerOpener = document.activeElement;
  drawerEl.hidden = false;
  // Move focus into the dialog so keyboard users land inside it, not behind it.
  const focusable = drawerEl.querySelector("button, [href], input, textarea, select");
  if (focusable) focusable.focus();
}
function closeDrawer(drawerEl) {
  if (drawerEl.hidden) return;
  drawerEl.hidden = true;
  if (_drawerOpener && _drawerOpener.focus) _drawerOpener.focus();  // restore focus to the trigger
  _drawerOpener = null;
}

/* ---------- cost overrides (kicker / X / free spells) ---------- */
// The mana cost to analyze a card by: a user override if set, else the printed cost.
function effectiveCost(card) {
  const o = state.costOverrides[card.name];
  return o != null ? o : card.cost;
}

// Recompute everything cost-derived (requirements, per-card spells, the curve,
// color demand, draw/ramp split, land target) from the last resolved deck. Called
// on analyze and again whenever a cost override changes — no Scryfall re-fetch.
function rebuildFromCosts() {
  const cards = state.resolvedCards || [];
  const qtyByName = state.qtyByName || {};
  state.requirements = requirementsForCards(
    cards.map((c) => ({ cost: effectiveCost(c) })), state.deckSize, state.threshold);

  state.spells = [];
  state.deckCards = [];
  for (const c of cards) {
    const cost = effectiveCost(c);
    const mv = manaValue(cost);
    if (!isLandType(c.type)) state.deckCards.push({ name: c.name, mv });  // transform DFCs are spells on the curve
    const cons = costConstraints(cost);
    const cols = Object.keys(cons);
    const { hybrid } = parseCost(cost);
    if (cols.length || hybrid.length) {
      const pips = {};
      for (const col of cols) pips[col] = cons[col].pips;
      const cheap = !!c.smooth && mv <= SMOOTH_MAX_MV;  // smooths early drops -> trims lands
      const dig = !!c.smooth && mv > SMOOTH_MAX_MV;     // 3 MV card advantage -> helps the top end
      // gold = needs >1 distinct color in the worst case (hard colors, plus a
      // hybrid whose colors don't overlap the hard ones); hybrids are resolved
      // to a concrete color at grade time against the live source counts.
      const gold = cols.length > 1 || (cols.length >= 1 && hybrid.length > 0) || hybrid.length > 1;
      state.spells.push({ name: c.name, image: c.image, qty: qtyByName[c.name] || 1, mv, gold, pips, hybrids: hybrid, smooth: cheap, dig });
    }
  }
  state.avgMV = state.deckCards.length
    ? state.deckCards.reduce((s, c) => s + c.mv, 0) / state.deckCards.length : 3;

  // How much the deck leans on each color (total colored pips) and the card
  // setting each color's requirement — feeds the recommender's shortfall
  // weighting and the actionable advice when a color can't be fully covered.
  state.demand = {}; state.colorInfo = {};
  for (const col of COLORS) { state.demand[col] = 0; state.colorInfo[col] = { cards: 0, driver: null }; }
  for (const sp of state.spells) {
    for (const col of Object.keys(sp.pips)) {
      const pips = sp.pips[col];
      state.demand[col] += pips * sp.qty;
      state.colorInfo[col].cards += sp.qty;
      const d = state.colorInfo[col].driver;
      if (!d || pips > d.pips || (pips === d.pips && sp.qty > d.qty)) {
        state.colorInfo[col].driver = { name: sp.name, pips, qty: sp.qty };
      }
    }
  }

  // Split draw/ramp by mana value: cheap (<=2 MV) smooths early drops and trims
  // the land target; mid-cost (3 MV) is card advantage that only helps the sim.
  const drawRamp = cards.filter((c) => c.smooth && !isLandType(c.type));
  state.smoothCards = drawRamp
    .filter((c) => manaValue(effectiveCost(c)) <= SMOOTH_MAX_MV)
    .map((c) => ({ name: c.name, qty: qtyByName[c.name] || 0, fetch: !!c.fetch }));
  state.digCards = drawRamp
    .filter((c) => manaValue(effectiveCost(c)) > SMOOTH_MAX_MV)
    .map((c) => ({ name: c.name, qty: qtyByName[c.name] || 0, fetch: !!c.fetch }));

  // Conditional fixing: turn on lands whose spell-type condition the deck meets.
  applyConditions(cards, qtyByName);

  state.landTarget = recommendLandCount(state.avgMV, state.deckSize, smoothCount());
}

// Re-run the cost-derived build after an override edit and refresh every view that
// reads it. The land build (state.counts) is untouched.
function recomputeFromCosts() {
  rebuildFromCosts();
  refreshDashboard();
  renderSpellStrip();
  markFixers();
  if (deckColors().size) { state.suggestedLands = null; computeSuggested(); }
  updateLandPanel();
  gradeBuild();
}

/* ---------- deck analysis (all local) ---------- */
async function analyzeDeck() {
  const text = $("#deckText").value.trim();
  const hint = $("#deckHint");
  if (!text) { hint.textContent = "Paste a decklist first."; hint.className = "hint warn"; return; }
  hint.textContent = "Analyzing…"; hint.className = "hint";
  try {
    const entries = deckEntries(parseDeckText(text), "deck");
    const qtyByName = {};
    let deckSize = 0;
    for (const e of entries) { qtyByName[e.name] = (qtyByName[e.name] || 0) + e.qty; deckSize += e.qty; }
    const names = cardNames(entries);
    const { cards, missing } = await resolveDeck(names);

    state.deckSize = deckSize || 60;
    const newDeck = text !== state.lastImportedDeck;
    // Reset per-card overrides on a new deck (so a previous deck's tweaks don't leak).
    if (newDeck) { state.smoothOverrides = {}; state.digOverrides = {}; state.costOverrides = {}; }

    // Stash the resolved deck so a cost-override edit can recompute everything
    // cost-derived without re-resolving from Scryfall.
    state.resolvedCards = cards;
    state.qtyByName = qtyByName;
    rebuildFromCosts();

    // Load the deck's own lands into the build so the dashboard + grades reflect
    // your actual manabase — only on a new deck (so confidence changes don't wipe edits).
    let loadedLands = 0, landsOutsidePool = 0;
    if (newDeck) {
      state.lastImportedDeck = text;
      state.counts = {};
      for (const c of cards) {
        if (!isLandType(c.type)) continue;
        const qty = qtyByName[c.name] || 0;
        if (state.tiles.has(c.name)) { state.counts[c.name] = qty; loadedLands += qty; }
        else landsOutsidePool += qty;
      }
      syncCountsToTiles();
    }

    localStorage.setItem(STORAGE_KEY, text);
    $("#dashEmpty").hidden = true;
    // One orchestrated beat: the five color rows ignite in WUBRG order on analyze.
    const colorsWrap = $("#colors");
    colorsWrap.classList.add("ignite");
    setTimeout(() => colorsWrap.classList.remove("ignite"), 800);
    refreshDashboard();
    renderSpellStrip();
    markFixers();
    // Default to the recommender-driven "Suggested" view. It falls back to the
    // broader "relevant" set until computeSuggested() resolves, then narrows.
    state.suggestedLands = null;  // stale from any previous deck
    setLandMode(deckColors().size ? "suggested" : "all");
    if (deckColors().size) computeSuggested();
    updateLandPanel();
    gradeBuild();
    populateDrawTool();
    $("#recommendBtn").disabled = false;
    $("#suggestToggle").disabled = false;
    $("#exportBtn").disabled = false;
    // Target now lives in the dashboard (Recommended row) + the Build button, so keep the topbar lean.
    $("#deckStatus").textContent = `${cards.length} cards · ${state.deckSize}-card deck`;
    const colors = COLORS.filter((c) => state.requirements[c] > 0).map((c) => COLOR_NAMES[c]);
    const parts = [colors.length ? `Needs ${colors.join(", ")} sources.` : "No colored requirements found."];
    if (loadedLands) parts.push(`Loaded ${loadedLands} lands from your deck.`);
    const sc = smoothCount();
    if (sc) {
      const delta = recommendLandCount(state.avgMV, state.deckSize, 0) - state.landTarget;
      parts.push(`${sc} cheap draw/ramp card${sc === 1 ? "" : "s"} (↻)` +
        (delta > 0 ? ` trim ~${delta} land${delta === 1 ? "" : "s"} off the target.` : ` factored into the target.`));
    }
    const dc = digCount();
    if (dc) parts.push(`${dc} mid-cost card-advantage spell${dc === 1 ? "" : "s"} (+) help the simulation reach lands for your expensive spells (no change to the land count).`);
    if (state.conditionsActive.size) parts.push(`Conditional lands active for: ${[...state.conditionsActive].join(", ")}.`);
    if (landsOutsidePool) parts.push(`${landsOutsidePool} land(s) not in the Standard pool.`);
    if (missing.length) parts.push(`${missing.length} card(s) not found.`);
    hint.className = "hint";
    hint.textContent = parts.join(" ");
  } catch (e) {
    hint.textContent = "Couldn't analyze: " + e.message; hint.className = "hint warn";
  }
}

/* ---------- per-card castability strip ---------- */
function renderSpellStrip() {
  const strip = $("#deckStrip");
  const grid = $("#spellGrid");
  const advice = $("#pdAdvice");   // lives inside the grid as its last child; rebuild around it
  grid.querySelectorAll(".spell").forEach((n) => n.remove());
  state.spellCells = new Map();
  if (!state.spells.length) { strip.hidden = true; $("#hudGrade").hidden = true; $("#mobileGrade").hidden = true; return; }
  strip.hidden = false;
  for (const spell of state.spells) {
    const cell = el("div", "spell");
    const ph = el("div", "sph"); ph.textContent = spell.name;
    const img = el("img"); img.alt = spell.name; img.loading = "lazy";
    img.addEventListener("load", () => img.classList.add("loaded"));
    if (spell.image) img.src = spell.image;
    const qty = el("span", "qty"); qty.textContent = spell.qty + "×";
    // Model reading — the mana-pie icon flags it as the COLORS %.
    const badge = el("div", "badge");
    badge.innerHTML =
      `<span class="axis-ico colors" title="Colors: are the right colors available by the turn you'd cast this, assuming you hit your land drops?" aria-label="Color reliability"></span>` +
      `<span class="bp"></span>`;
    // Simulated reading — the clock icon flags it as the LANDS-ON-TIME %. Two
    // figures, always both shown: on the play → on the draw (draw is always ≥ play).
    const simPill = el("div", "sim-pill");
    simPill.hidden = true;
    simPill.innerHTML =
      `<svg class="axis-ico timing" viewBox="0 0 16 16" role="img" aria-label="Real games: lands on time, on the play then on the draw"><title>Real games: do you draw enough lands, on time? Simulated on-curve rate (incl. screw &amp; flood) — on the play → on the draw.</title>` +
      `<circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" stroke-width="1.4"/>` +
      `<path d="M8 8 L8 4.2 M8 8 L10.7 9.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>` +
      `<span class="sp-p sp-play" title="on the play"></span>` +
      `<span class="sp-sep" aria-hidden="true">→</span>` +
      `<span class="sp-p sp-draw" title="on the draw"></span>`;
    cell.append(ph, img, qty, badge, simPill);
    if (spell.smooth) {                          // cheap (<=2 MV) draw/ramp — trims lands + helps sim
      const tag = el("button", "smooth-tag");
      tag.textContent = "↻";
      tag.title = "Cheap draw/ramp — smooths your early drops, so it lowers the recommended land count and helps the simulation. Click to adjust how many copies count.";
      tag.addEventListener("click", (e) => { e.stopPropagation(); openSmoothPop(spell.name, spell.qty, tag, "smooth"); });
      cell.appendChild(tag);
    } else if (spell.dig) {                       // 3 MV card advantage — helps the top end, not the land count
      const tag = el("button", "dig-tag");
      tag.textContent = "+";
      tag.title = "Card advantage — too slow to fix early drops, so it doesn't lower your land count, but it digs toward the lands your expensive spells need (the simulation rewards it). Click to adjust how many copies count.";
      tag.addEventListener("click", (e) => { e.stopPropagation(); openSmoothPop(spell.name, spell.qty, tag, "dig"); });
      cell.appendChild(tag);
    }
    // Cost-override affordance: cast this card at the cost you'll actually pay
    // (kicker, X pinned, a free spell's alternative cost…). Marks the cell when set.
    const overridden = state.costOverrides[spell.name] != null;
    const costTag = el("button", "cost-tag");
    costTag.textContent = "✎";
    costTag.title = overridden
      ? `Cost overridden to ${state.costOverrides[spell.name]}. Click to change or reset.`
      : "Override the mana cost you'll actually pay (kicker, X, a free spell's alt cost). Click to set.";
    costTag.setAttribute("aria-label", `Override cost for ${spell.name}`);
    costTag.addEventListener("click", (e) => { e.stopPropagation(); openCostPop(spell, costTag); });
    cell.appendChild(costTag);
    if (overridden) cell.dataset.costOverride = "1";
    grid.insertBefore(cell, advice);   // cards before the advice, which stays the last cell
    state.spellCells.set(spell.name, cell);
  }
}

let _gradeTimer = null, _simTimer = null;
function gradeBuild() {
  if (!state.spells.length) return;
  clearTimeout(_gradeTimer);
  // Model grades first (instant), then the screw-aware sim during idle time.
  _gradeTimer = setTimeout(() => { doGrade(); scheduleSim(); }, 90);
}

// A spell's colors-only castability under the given per-color source counts.
// Resolves each two-color hybrid pip to the color with the most live sources (the
// one you're likeliest to pay it with), then runs the conditional Karsten model.
// Shared by the live grade strip and the JSON export so they never drift.
function spellColorProb(spell, sources, total) {
  const pips = { ...spell.pips };
  for (const pair of (spell.hybrids || [])) {
    let best = pair[0];
    for (const c of pair) if ((sources[c] || 0) > (sources[best] || 0)) best = c;
    pips[best] = (pips[best] || 0) + 1;
  }
  const cols = Object.keys(pips).filter((c) => pips[c] > 0);
  if (cols.length <= 1) {
    const c = cols[0];
    return c ? castableProbability(pips[c], spell.mv, sources[c], state.deckSize, total) : 1;
  }
  const srcByColor = {};
  for (const c of cols) srcByColor[c] = sources[c];
  return multivariateCastable(pips, spell.mv, srcByColor, state.deckSize, total);
}

function doGrade() {
  const t = tally();
  const sources = { W: t.W, U: t.U, B: t.B, R: t.R, G: t.G };
  let worst = 1;
  for (const spell of state.spells) {
    const prob = spellColorProb(spell, sources, t.total);
    const cell = state.spellCells.get(spell.name);
    if (cell) {
      cell.dataset.g = grade(prob).letter;   // data-g drives the gentle color tint only
      cell.querySelector(".bp").textContent = pct(prob);
      // The sim pill keeps its prior value until scheduleSim() refreshes it a beat
      // later — no flicker on every edit.
    }
    worst = Math.min(worst, prob);
  }
  state.staticWorst = worst;
  $("#hudGrade").hidden = false;
  const og = $("#overallGrade");
  const ogl = og.querySelector(".og-letter");
  ogl.textContent = pct(worst);
  ogl.dataset.g = grade(worst).letter;
  og.querySelector(".og-text").textContent = `Weakest card on curve, colors only`;
  updateMobileGrade(pct(worst), grade(worst).letter);
}

// Display percentage, capped at 99% — the closed-form model conditions on hitting
// your land drops (it measures colour reliability, not raw mana screw), so nothing
// is 100%. The simulator is also capped for consistency.
function pct(p) {
  return Math.min(99, Math.round(p * 100)) + "%";
}

// Mirror the HUD's overall figure into the mobile-only chip (the sticky HUD is gone
// on small screens). Mirrors whatever the HUD currently shows: colors first, then
// the screw-aware sim once it resolves.
function updateMobileGrade(text, g) {
  const m = $("#mobileGrade");
  if (!m) return;
  m.hidden = false;
  const letter = m.querySelector(".mg-letter");
  letter.textContent = text;
  letter.dataset.g = g;
}

/* ---------- Monte-Carlo validator (auto, lazy; includes mana screw) ---------- */
// Runs itself a beat after the model grades, during idle time, so the true
// (screw-aware) odds stay current without the user pressing anything.
function scheduleSim() {
  clearTimeout(_simTimer);
  _simTimer = setTimeout(() => idle(doSimulate), 130);
}
// Memoized sim results so toggling "Preview the cut" never recomputes the real build's
// figures. Keyed by a build signature; the leaner cut version is filled in lazily.
const simCache = { key: null, play: null, drawFull: null, drawCut: null, slack: null };

// Everything the simulation + the cut plan depend on. Zero-count lands are dropped so a
// land bumped up then back down doesn't spuriously miss the cache.
function simKey(drawCount, fetches) {
  const counts = {};
  for (const [n, c] of Object.entries(state.counts)) if (c > 0) counts[n] = c;
  return JSON.stringify({ counts, drawCount, fetches, deck: state.deckSize,
    req: state.requirements, spells: state.spells.map((s) => s.name) });
}

function doSimulate() {
  if (!state.spells.length) return;
  const lands = currentSimLands();
  // Both cheap smoothers and mid-cost diggers help you find lands in a real game.
  const drawCount = smoothCount() + digCount();
  const fetches = fetchCount();
  // On a build/deck change, recompute the real build's play + on-the-draw figures and the
  // cut plan once, and clear the lazy cut version. Seeded (common random numbers) so the
  // figures stay stable between edits and the preview moves only the cards a cut affects.
  const key = simKey(drawCount, fetches);
  if (simCache.key !== key) {
    const opts = { trials: 5000, drawCount, fetchCount: fetches, seed: BATTLE_SEED };
    simCache.key = key;
    simCache.play = simulateDeck(state.spells, lands, state.deckSize, { ...opts, onPlay: true });
    simCache.drawFull = simulateDeck(state.spells, lands, state.deckSize, { ...opts, onPlay: false });
    simCache.slack = computeDrawSlack();
    simCache.drawCut = null;            // lazy — only built when the user actually previews
  }
  const slack = simCache.slack;
  const previewing = state.previewCut && slack.cut > 0;
  // Lazily simulate the leaner (cut) build the first time it's previewed, then cache it —
  // so swapping into the preview costs one sim and reverting costs none.
  if (previewing && !simCache.drawCut) {
    simCache.drawCut = simulateDeck(state.spells, slack.cutLands, state.deckSize,
      { trials: 5000, drawCount, fetchCount: fetches, seed: BATTLE_SEED, onPlay: false });
  }
  const resPlay = simCache.play;
  const resDraw = previewing ? simCache.drawCut : simCache.drawFull;
  // Refresh both figures on each card's clock pill — the model badge stays as-is. The
  // play figure is always your real build; the draw figure follows the preview.
  for (const spell of state.spells) {
    const cell = state.spellCells.get(spell.name);
    if (!cell) continue;
    const pp = resPlay.bySpell[spell.name], pd = resDraw.bySpell[spell.name];
    const playEl = cell.querySelector(".sp-play"), drawEl = cell.querySelector(".sp-draw");
    playEl.textContent = pct(pp); playEl.dataset.g = grade(pp).letter;
    drawEl.textContent = pct(pd); drawEl.dataset.g = grade(pd).letter;
    const pill = cell.querySelector(".sim-pill");
    // Average delay (turns late) on the play — surfaced as a tooltip so the strip
    // stays uncluttered. 0.0 means it's on curve essentially every game.
    const delay = resPlay.delayBySpell[spell.name];
    if (delay != null) {
      const title = pill.querySelector("title");
      const base = "Real games: do you draw enough lands, on time? Simulated on-curve rate (incl. screw & flood) — on the play → on the draw.";
      if (title) title.textContent = `${base} Avg delay when not on curve: +${delay.toFixed(1)} turns.`;
    }
    pill.hidden = false;
  }
  $("#spellGrid").classList.toggle("preview-draw", previewing);   // dotted cue on the → figures
  // Overall headline = the true (simulated) weakest on the play (the conservative floor);
  // the draw figure and the colors model ride along as context.
  $("#hudGrade").hidden = false;
  const og = $("#overallGrade");
  const ogl = og.querySelector(".og-letter");
  ogl.textContent = pct(resPlay.overall);
  ogl.dataset.g = grade(resPlay.overall).letter;
  // Keep-rate context: how often this build keeps seven, and how often it digs to a
  // mulligan — the headline "real games" figure already prices the mulligans in.
  const kr = resPlay.keepRates, mr = resPlay.mulliganRate;
  const keepNote = kr
    ? ` · keeps 7 in ${Math.round(kr[7] * 100)}% of games, mulligans ${Math.round(mr * 100)}%`
    : "";
  og.querySelector(".og-text").textContent =
    `Weakest card in real games, incl. screw · ${pct(resDraw.overall)} on the draw${previewing ? " (−" + slack.cut + ")" : ""} · ${pct(state.staticWorst != null ? state.staticWorst : resPlay.overall)} on colors alone${keepNote}`;
  updateMobileGrade(pct(resPlay.overall), grade(resPlay.overall).letter);
  renderDrawSlack(slack);   // "you can cut N lands on the draw" guidance + the preview button
}

/* ---------- "land slack on the draw" sideboard guidance ---------- */
// The current build as sim land tokens (same shape doSimulate builds).
function currentSimLands() {
  const lands = [];
  for (const { land } of state.tiles.values()) {
    const c = state.counts[land.name] || 0;
    if (c) lands.push({ colors: land.colors, tapped: !!land.tapped, basic: !!land.basic, needsBasic: !!land.needsBasic, slow: !!land.slow, untapBasic: !!land.untapBasic, count: c });
  }
  return lands;
}

// The basic to shave: the one whose color the build over-supplies most vs. its
// requirement (cutting your most redundant source is the safe move). Index, or -1.
function cutTargetIdx(lands) {
  const supply = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const l of lands) for (const c of l.colors) supply[c] += l.count;
  let best = -1, bestSlack = -Infinity;
  lands.forEach((l, i) => {
    if (!l.basic || l.count <= 0 || l.colors.length !== 1) return;
    const slack = supply[l.colors[0]] - (state.requirements[l.colors[0]] || 0);
    if (slack > bestSlack) { bestSlack = slack; best = i; }
  });
  return best;
}

// How many lands you can cut while on the draw and still match your on-the-play
// reliability — the established "−1 land on the draw" sideboard move, quantified.
// Common random numbers (fixed per-trial seed) keep the play-vs-draw bar comparison
// low-variance; capped at 2 (the observed range) to stay cheap.
function computeDrawSlack() {
  const base = currentSimLands();
  const total = base.reduce((s, l) => s + l.count, 0);
  if (!state.spells.length || !total) return { cut: 0, color: null, total };
  const drawCount = smoothCount() + digCount();
  const fetches = fetchCount();
  const overall = (lands, onPlay) =>
    simulateDeck(state.spells, lands, state.deckSize, { trials: 4000, seed: BATTLE_SEED, drawCount, fetchCount: fetches, onPlay }).overall;
  const playBar = overall(base, true);          // on the play, full build — the bar to clear
  let work = base.map((l) => ({ ...l }));
  let cut = 0, color = null, drawAfter = overall(base, false);   // on the draw, before any cut
  while (cut < 2) {
    const idx = cutTargetIdx(work);
    if (idx < 0) break;
    const trial = work.map((l) => ({ ...l }));
    trial[idx] = { ...trial[idx], count: trial[idx].count - 1 };
    const d = overall(trial.filter((l) => l.count > 0), false);
    if (d < playBar) break;                      // cutting further would drop below the play bar
    work = trial; cut++; color = trial[idx].colors[0]; drawAfter = d;
  }
  // cutLands: the leaner build the recommendation implies — used to PREVIEW the draw %
  // (the real build is never modified).
  return { cut, color, total, playBar, drawAfter, cutLands: work.filter((l) => l.count > 0) };
}

// Renders the sideboard guidance + the "Preview the cut" toggle. `slack` is passed in
// from doSimulate (computed once); falls back to computing it if called standalone.
function renderDrawSlack(slack) {
  const box = $("#pdAdvice");
  if (!box) return;
  if (!state.spells.length) { box.hidden = true; return; }
  const { cut, color, total, playBar, drawAfter } = slack || computeDrawSlack();
  if (!total) { box.hidden = true; return; }
  const lead = `<span class="pa-h">On the draw</span> you see an extra card each game`;
  if (cut <= 0) {
    state.previewCut = false;
    box.innerHTML = `${lead} — but this build has no land to spare, so keep all <strong>${total}</strong>.`;
    box.hidden = false;
    return;
  }
  const lands = cut === 1 ? "<strong>1 land</strong>" : `<strong>${cut} lands</strong>`;
  const which = color ? ` (a ${COLOR_NAMES[color]} basic, your most over-supplied color)` : "";
  const body = state.previewCut
    ? `${lead}. The <span class="pa-h">→</span> figures now preview cutting ${lands}${which}: your weakest card ` +
      `holds <strong>${pct(drawAfter)}</strong> on the draw, at or above its <strong>${pct(playBar)}</strong> ` +
      `on the play. Your build is unchanged.`
    : `${lead}, so you can run leaner. Cutting ${lands}${which} would leave your weakest card at ` +
      `<strong>${pct(drawAfter)}</strong> on the draw — still at or above its <strong>${pct(playBar)}</strong> on the play.`;
  const btn = `<button type="button" id="previewCutBtn" class="pa-btn${state.previewCut ? " on" : ""}">` +
    `${state.previewCut ? "Show actual draw %" : "Preview the cut"}</button>`;
  // Text in its own block, button pinned to the box bottom (CSS) — so toggling the
  // text above never shifts the button.
  box.innerHTML = `<span class="pa-text">${body}</span>${btn}`;
  box.hidden = false;
}

/* ---------- recommendation ---------- */
// Render a recommend()/optimize() result into the drawer list + summary.
function renderRecList(rec, summaryText) {
  const byName = new Map(state.lands.map((l) => [l.name, l]));
  const picks = Object.entries(rec.counts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => {
      const l = byName.get(name) || {};
      return { name, count, colors: l.colors || [], img: l.image_hi || l.image || "" };
    });
  const list = $("#recList");
  list.innerHTML = "";
  for (const p of picks) {
    const row = el("div", "rec-row");
    const dots = p.colors.map((c) => `<i style="background:var(--${c})"></i>`).join("");
    row.innerHTML = `<span class="rc">${p.count}×</span><span class="rn">${p.name}</span><span class="rd">${dots}</span>`;
    if (p.img) {
      row.addEventListener("mouseenter", (e) => showPreview(p.img, e.clientX, e.clientY));
      row.addEventListener("mousemove", (e) => positionPreview(e.clientX, e.clientY));
      row.addEventListener("mouseleave", hidePreview);
    }
    list.appendChild(row);
  }
  state.lastRec = picks;
  $("#recSummary").textContent = summaryText;
}

const _shortNote = (rec) => {
  const short = Object.keys(rec.shortfall || {});
  return short.length ? ` · still short on ${short.join(", ")}` : " · every color covered";
};

// The ILP objectives we present, in display/priority order. Identical results are
// deduped (keeping the higher-priority label), so the user sees only distinct bases.
const REC_OBJECTIVES = ["untapped", "taplands", "lands"];
// Distinct *choices* are distinct (land count, tapped count) tradeoffs — that's
// what the user sees and decides on. Objectives that land on the same tradeoff
// (e.g. "most untapped" and "fewest tapped" both at 24 lands / 0 tapped) collapse
// to one option, keeping the higher-priority label.
const _sig = (rec) => rec.total + "|" + rec.taplands;

// Solve every objective and return the distinct optimal bases (deduped by their
// land-count / tapland tradeoff). Shared by the Recommend drawer and the
// "Suggested" land filter, so both tell the same story.
async function computeRecOptions() {
  const results = await Promise.all(
    REC_OBJECTIVES.map((objective) =>
      optimizeManabase({
        requirements: state.requirements, lands: state.lands,
        landTarget: state.landTarget, objective, demandWeights: state.demand,
      }).then((rec) => ({ objective, rec }), () => null)),
  );
  const options = [];
  const byObjective = [];   // every feasible objective (pre-dedup) — lets callers see what collapsed
  const seen = new Set();
  for (const r of results) {
    if (!r || !r.rec.feasible) continue;
    byObjective.push({ objective: r.objective, label: OBJECTIVES[r.objective].label, rec: r.rec });
    const sig = _sig(r.rec);
    if (seen.has(sig)) continue;
    seen.add(sig);
    options.push({ label: OBJECTIVES[r.objective].label, rec: r.rec });
  }
  return { options, byObjective };
}

// Battle-tested scores every candidate build on the SAME per-trial draws (common
// random numbers via simulateDeck's `seed`), so the comparison between builds is
// low-variance and the pick is deterministic — even though each absolute number is
// still noisy. Per-trial seeding keeps trial t in sync across builds even when they
// mulligan at different rates.
const BATTLE_SEED = 0x9e3779b9;

// The "Battle-tested" option: ask the ILP for candidate bases across a range of land
// counts, then let the Monte-Carlo simulator pick the leanest one that still casts
// the whole curve about as reliably as any. The simulator (used elsewhere only as a
// validator) becomes the recommender's objective. Returns { label, rec, sim } or
// null (no spells / solver down) — callers fall back to the ILP options.
async function computeBattleTested() {
  const drawCount = smoothCount() + digCount();
  const fetches = fetchCount();
  // Per-trial common random numbers: every candidate faces the identical luck on
  // each trial (robust to builds mulliganing at different rates), so the comparison
  // is low-variance and the pick is deterministic.
  const simulate = (buildLands, deckSize, trials) =>
    simulateDeck(state.spells, buildLands, deckSize, { trials, drawCount, fetchCount: fetches, seed: BATTLE_SEED });
  const pick = await battleTested({
    requirements: state.requirements, lands: state.lands, landTarget: state.landTarget,
    demandWeights: state.demand, spells: state.spells, deckSize: state.deckSize, simulate,
  });
  return pick ? { label: "Battle-tested", rec: pick.rec, sim: pick.sim } : null;
}

// Build the "Suggested" filter set: every land any optimal base reaches for, plus
// on-color basics (always a tuning lever). These are the same picks Build manabase
// offers — narrowing the full pool to what the recommender would actually run.
let _suggestRun = 0;
async function computeSuggested() {
  const run = ++_suggestRun;
  try {
    const { options } = await computeRecOptions();
    if (run !== _suggestRun) return;  // superseded by a newer analyze
    const set = new Set();
    for (const opt of options) for (const name of Object.keys(opt.rec.counts)) set.add(name);
    const dc = deckColors();
    for (const l of state.lands) if (l.basic && l.colors.some((c) => dc.has(c))) set.add(l.name);
    state.suggestedLands = set.size ? set : null;  // null → passesMode falls back to "relevant"
  } catch {
    if (run !== _suggestRun) return;
    state.suggestedLands = null;  // solver unavailable
  }
  if (state.landMode === "suggested") applyVisibility();
}

// Compute every optimal manabase up front and let the user compare and pick.
let _recRun = 0;
async function computeAllRecs() {
  const run = ++_recRun;
  state.recOptions = [];
  state.lastRec = null;
  $("#recApply").disabled = true;
  $("#recOptions").innerHTML = "";
  $("#recList").innerHTML = "";
  renderAdvice(null);
  $("#recSummary").textContent = "Working out your options…";

  try {
    // The ILP options and the sim-in-the-loop "Battle-tested" pick run in parallel;
    // battle-tested is best-effort (null if there are no spells / the sim can't run).
    const [{ options: baseOptions, byObjective }, battle] = await Promise.all([
      computeRecOptions(),
      computeBattleTested().catch(() => null),
    ]);
    if (run !== _recRun) return;  // superseded by a newer open/recompute

    // Battle-tested leads — it's the sim-validated pick and the new default. Drop any
    // ILP option that lands on the exact same (count, tapped) tradeoff so the user
    // doesn't see a twin without its own distinct story — but record which goals it
    // coincides with so the option can say so (e.g. "also the most-untapped build").
    let options = baseOptions;
    if (battle) {
      const bsig = _sig(battle.rec);
      battle.coincides = byObjective.filter((o) => _sig(o.rec) === bsig).map((o) => o.objective);
      options = [battle, ...baseOptions.filter((o) => _sig(o.rec) !== bsig)];
    }

    if (options.length) {
      state.recOptions = options;
      renderRecOptions(options);
      selectRecOption(0);
      renderAdvice(options);
      return;
    }

    // No feasible optimal base at this target — fall back to the greedy heuristic,
    // which always returns something (possibly short), and explain.
    const greedy = recommendManabase(state.requirements, state.lands, { landTarget: state.landTarget });
    state.recOptions = [{ label: "Best effort", rec: greedy }];
    renderRecOptions(state.recOptions);
    selectRecOption(0);
    $("#recSummary").textContent =
      `No base can fully meet these requirements at ~${state.landTarget} lands — showing the closest fit. ` +
      `Raise the land count, lower your target confidence, or add more dual lands.`;
  } catch (e) {
    if (run !== _recRun) return;
    // Solver unavailable: fall back to the greedy recommender.
    const greedy = recommendManabase(state.requirements, state.lands, { landTarget: state.landTarget });
    state.recOptions = [{ label: "Balanced", rec: greedy }];
    renderRecOptions(state.recOptions);
    selectRecOption(0);
    $("#recSummary").textContent = `Optimizer unavailable (${e.message}); showing the balanced recommendation.`;
  }
}

// Plain-English "how this build was chosen" — shown on hover so the option labels
// can stay short. Battle-tested is the sim-in-the-loop pick; the rest each solve one
// abstract goal (and say so, so nobody mistakes a source-count proxy for simulated play).
function recOptionTip(opt) {
  const t = state.landTarget || "your recommended count";
  if (opt.sim) {
    return `Chosen by simulation, not a rule of thumb. We build candidates at a few land counts `
      + `around the recommended ${t}, then play each out over thousands of games — real shuffles, `
      + `London mulligans and mana screw included — and keep the count and shape that casts your `
      + `curve on time most often (with a small penalty for running extra lands you'd flood on). `
      + `${pct(opt.sim.overall)} is that simulated on-curve rate.`;
  }
  switch (opt.rec.objective) {
    case "untapped": return `Solved to maximize colored sources that enter untapped, at ~${t} lands. `
      + `Fast, but it optimizes source counts rather than simulated games.`;
    case "taplands": return `Solved to use as few tapped lands as possible, at ~${t} lands.`;
    case "lands":    return `Solved to cover your colors with as few lands as possible (no more than ~${t}).`;
    default:         return "A best-effort base when no option fully covers your colors at this count.";
  }
}

// Render the selectable list of computed options (name + headline stats).
function renderRecOptions(options) {
  const wrap = $("#recOptions");
  wrap.innerHTML = "";
  options.forEach((opt, i) => {
    const btn = el("button", "rec-option");
    btn.dataset.i = i;
    btn.title = recOptionTip(opt);   // hover: how this build was chosen
    // Battle-tested carries its simulated on-curve castability and a "simulated"
    // badge; the ILP options show the land-count / tapped tradeoff they optimize for.
    const stat = opt.sim
      ? `${opt.rec.total} lands · ${opt.rec.taplands} tapped · ${pct(opt.sim.overall)} on curve`
      : `${opt.rec.total} lands · ${opt.rec.taplands} tapped`;
    if (opt.sim) btn.classList.add("battle");
    const badge = opt.sim ? `<span class="ro-badge">simulated</span>` : "";
    btn.innerHTML =
      `<span class="ro-main"><span class="ro-name">${opt.label}</span>${badge}</span>` +
      `<span class="ro-stat">${stat}</span>`;
    wrap.appendChild(btn);
  });
}

// Actionable advice for the chosen target: what's covered, and — when a color
// can't be — the concrete levers (add lands, accept the risk, cut the pip-heavy
// card). Lives just under the option list; null clears it.
function renderAdvice(options) {
  let box = $("#recAdvice");
  if (!box) {
    box = el("div", "rec-advice");
    box.id = "recAdvice";
    const sum = $("#recSummary");
    sum.parentNode.insertBefore(box, sum);  // above the per-option summary line
  }
  box.innerHTML = "";
  if (!options || !options.length) { box.hidden = true; return; }
  const advice = manabaseAdvice(options, {
    requirements: state.requirements, landTarget: state.landTarget,
    demand: state.demand, colorInfo: state.colorInfo,
  });
  box.dataset.status = advice.status;
  const h = el("p", "adv-headline"); h.textContent = advice.headline; box.appendChild(h);
  for (const d of advice.detail) { const p = el("p", "adv-detail"); p.textContent = d; box.appendChild(p); }
  if (advice.levers.length) {
    const ul = el("ul", "adv-levers");
    for (const lv of advice.levers) { const li = el("li"); li.textContent = lv; ul.appendChild(li); }
    box.appendChild(ul);
  }
  box.hidden = false;
}

// When battle-tested's build is identical to one or more ILP goals (common — they
// often converge on the same lands), say so instead of silently swallowing them.
const COINCIDE_PHRASE = { untapped: "most untapped", taplands: "fewest tapped", lands: "leanest" };
function coincideNote(opt) {
  const ks = (opt.coincides || []).filter((k) => COINCIDE_PHRASE[k]);
  if (!ks.length) return "";
  const p = ks.map((k) => COINCIDE_PHRASE[k]);
  const joined = p.length === 1 ? p[0] : p.slice(0, -1).join(", ") + " and " + p[p.length - 1];
  return ` · also the ${joined} build for these colors`;
}

function selectRecOption(i) {
  const opt = state.recOptions[i];
  if (!opt) return;
  for (const b of document.querySelectorAll("#recOptions .rec-option")) {
    b.classList.toggle("on", Number(b.dataset.i) === i);
  }
  // Battle-tested is selected by simulation, not by a single ILP goal, so it gets
  // its own note (the simulated castability it was chosen on, plus any ILP goals it
  // coincides with — so a collapsed single option isn't a mystery).
  const note = opt.sim
    ? `simulated best · ${pct(opt.sim.overall)} on curve${coincideNote(opt)}`
    : (state.recOptions.length > 1 ? "optimal for this goal — " + opt.label.toLowerCase() : opt.label.toLowerCase());
  renderRecList(opt.rec, `${opt.rec.total} lands · ${opt.rec.taplands} tapped · ${note}${_shortNote(opt.rec)}`);
  $("#recApply").disabled = false;
}

function recommend() {
  // Apply REPLACES the whole build (state.counts = {}). Say so when there's a build
  // to lose, so hand-tuning never vanishes by surprise.
  $("#recApply").textContent = tally().total > 0 ? "Replace build with this" : "Apply to build";
  openDrawer($("#recDrawer"));
  computeAllRecs();
}

function applyRecommendation() {
  if (!state.lastRec) return;
  state.counts = {};
  for (const p of state.lastRec) state.counts[p.name] = p.count;
  closeDrawer($("#recDrawer"));
  syncCountsToTiles();
  applyVisibility();
  markFixers();
  refreshDashboard();
  gradeBuild();
}

/* ---------- export & share ---------- */
// The current deck + chosen manabase as an Arena/MTGO-importable decklist.
function decklistText() {
  const lines = ["Deck"];
  const spellByName = new Map(state.spells.map((s) => [s.name, s]));
  for (const c of state.deckCards) {
    const s = spellByName.get(c.name);
    lines.push(`${s ? s.qty : 1} ${c.name}`);
  }
  const land = [];
  for (const l of state.lands) {
    const n = state.counts[l.name] || 0;
    if (n) land.push(`${n} ${l.name}`);
  }
  if (land.length) { lines.push(""); lines.push(...land); }
  return lines.join("\n");
}

function openExport() {
  const text = decklistText();
  $("#exportText").value = text;
  $("#exportCopied").textContent = "";
  openDrawer($("#exportModal"));
  navigator.clipboard?.writeText(text).then(
    () => { $("#exportCopied").textContent = "Decklist copied to clipboard."; },
    () => { $("#exportCopied").textContent = "Select all and copy."; },
  );
}

// The full analysis as a plain, versioned object — requirements, the chosen build,
// colors-only grades + simulated on-curve odds. Grades reuse spellColorProb and the
// same simulateDeck call the live view uses, so nothing is scraped from the DOM.
function buildAnalysisJSON() {
  const t = tally();
  const sources = { W: t.W, U: t.U, B: t.B, R: t.R, G: t.G };
  const drawCount = smoothCount() + digCount();
  const fetches = fetchCount();
  const sp = state.spells.length
    ? simulateDeck(state.spells, currentSimLands(), state.deckSize, { trials: 5000, drawCount, fetchCount: fetches, onPlay: true, seed: BATTLE_SEED })
    : null;
  const sd = state.spells.length
    ? simulateDeck(state.spells, currentSimLands(), state.deckSize, { trials: 5000, drawCount, fetchCount: fetches, onPlay: false, seed: BATTLE_SEED })
    : null;
  const cards = state.spells.map((spell) => {
    const colorsProb = spellColorProb(spell, sources, t.total);
    return {
      name: spell.name, qty: spell.qty, mv: spell.mv,
      colorsPct: Math.round(colorsProb * 100),
      simPlayPct: sp ? Math.round(sp.bySpell[spell.name] * 100) : null,
      simDrawPct: sd ? Math.round(sd.bySpell[spell.name] * 100) : null,
      avgDelay: sp ? Number(sp.delayBySpell[spell.name].toFixed(2)) : null,
      overridden: state.costOverrides[spell.name] != null,
    };
  });
  const build = [];
  for (const l of state.lands) {
    const n = state.counts[l.name] || 0;
    if (n) build.push({ name: l.name, count: n, colors: l.colors, tapped: !!l.tapped, basic: !!l.basic });
  }
  return {
    schema: "mtg-manabase/1",
    deck: { size: state.deckSize, avgMV: Number(state.avgMV.toFixed(2)), threshold: state.threshold, text: state.lastImportedDeck || $("#deckText").value.trim() },
    requirements: { ...state.requirements },
    build: { lands: build, total: t.total, landTarget: state.landTarget },
    grades: {
      overallColors: state.staticWorst != null ? Math.round(state.staticWorst * 100) : null,
      overallSimPlay: sp ? Math.round(sp.overall * 100) : null,
      overallSimDraw: sd ? Math.round(sd.overall * 100) : null,
      keepSeven: sp ? Math.round(sp.keepRates[7] * 100) : null,
      mulliganRate: sp ? Math.round(sp.mulliganRate * 100) : null,
      cards,
    },
    costOverrides: { ...state.costOverrides },
    conditionsActive: [...state.conditionsActive],
  };
}

// Trigger a client-side file download (no dependency).
function downloadBlob(filename, mime, text) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function exportAnalysisJSON() {
  const json = JSON.stringify(buildAnalysisJSON(), null, 2);
  downloadBlob("manabase-analysis.json", "application/json", json);
  $("#exportCopied").textContent = "Analysis JSON downloaded.";
}

// --- shareable URL (deck + build encoded in the hash) ----------------------
const _b64u = {
  enc: (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  dec: (s) => {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

async function encodeShare(payload) {
  const json = JSON.stringify(payload);
  // Compress with the built-in gzip stream when available; fall back to a plain
  // (uncompressed) URI-encoded payload otherwise. The "z"/"u" prefix tags which.
  if (typeof CompressionStream === "function") {
    const cs = new CompressionStream("deflate-raw");
    const writer = cs.writable.getWriter();
    writer.write(new TextEncoder().encode(json)); writer.close();
    const buf = new Uint8Array(await new Response(cs.readable).arrayBuffer());
    return "z" + _b64u.enc(buf);
  }
  return "u" + encodeURIComponent(json);
}

async function decodeShare(hash) {
  const tag = hash[0], body = hash.slice(1);
  if (tag === "u") return JSON.parse(decodeURIComponent(body));
  if (tag === "z") {
    const ds = new DecompressionStream("deflate-raw");
    const writer = ds.writable.getWriter();
    writer.write(_b64u.dec(body)); writer.close();
    const text = await new Response(ds.readable).text();
    return JSON.parse(text);
  }
  return null;
}

async function copyShareLink() {
  const deck = state.lastImportedDeck || $("#deckText").value.trim();
  if (!deck) { $("#exportCopied").textContent = "Analyze a deck first."; return; }
  const payload = { v: 1, deck, conf: state.threshold, lands: { ...state.counts } };
  const url = location.origin + location.pathname + "#" + (await encodeShare(payload));
  $("#exportText").value = url;
  navigator.clipboard?.writeText(url).then(
    () => { $("#exportCopied").textContent = "Share link copied to clipboard."; },
    () => { $("#exportCopied").textContent = "Select all and copy the link above."; },
  );
}

// Reconstruct a shared analysis from location.hash, if present. Returns true if it
// handled a link (so boot skips the localStorage path).
async function loadFromShareLink() {
  const hash = location.hash.slice(1);
  if (!hash) return false;
  let payload;
  try { payload = await decodeShare(hash); } catch { return false; }
  if (!payload || !payload.deck) return false;
  $("#deckText").value = payload.deck;
  if (payload.conf != null) { $("#confSel").value = String(payload.conf); state.threshold = payload.conf; }
  await analyzeDeck();
  // Apply the shared custom build after analyze (analyze seeds counts from the
  // deck's own lands; this overrides with the exact shared manabase).
  if (payload.lands && Object.keys(payload.lands).length) {
    state.counts = { ...payload.lands };
    syncCountsToTiles();
    applyVisibility();
    markFixers();
    refreshDashboard();
    gradeBuild();
  }
  return true;
}

/* ---------- draw-odds query tool ---------- */
// Rebuild the card dropdown from the analyzed deck (name -> copies), keeping the
// "Custom numbers" sentinel first. Called after each analyze.
function populateDrawTool() {
  const sel = $("#drawCardSel");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = `<option value="__custom__">Custom numbers…</option>`;
  const names = Object.keys(state.qtyByName || {}).sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = `${state.qtyByName[name]}× ${name}`;
    sel.appendChild(opt);
  }
  // Keep the prior selection if it still exists, else default to the first real card.
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
  else if (names.length) sel.value = names[0];
  recomputeDrawOdds();
}

// Resolve the query's population N and successes K from the current controls.
function drawQueryParams() {
  const sel = $("#drawCardSel");
  const custom = !sel || sel.value === "__custom__";
  $("#drawCustoms").hidden = !custom;
  if (custom) {
    return {
      population: Math.max(1, parseInt($("#drawPop").value, 10) || 60),
      successes: Math.max(0, parseInt($("#drawSucc").value, 10) || 0),
      label: "this card",
    };
  }
  return {
    population: state.deckSize || 60,
    successes: state.qtyByName[sel.value] || 0,
    label: sel.value,
  };
}

function recomputeDrawOdds() {
  const readout = $("#drawReadout");
  const chart = $("#drawChart");
  if (!readout || !chart) return;
  const { population, successes, label } = drawQueryParams();
  const k = Math.max(1, parseInt($("#drawN").value, 10) || 1);
  const turn = Math.max(1, Math.min(15, parseInt($("#drawTurn").value, 10) || 1));
  const onPlay = $("#drawPlay").value !== "draw";
  const p = drawOddsByTurn(population, successes, k, turn, onPlay);
  const copies = successes === 1 ? "copy" : "copies";
  readout.innerHTML =
    `<strong>${(p * 100).toFixed(1)}%</strong> to draw ≥${k} of ${successes} ${copies}` +
    ` of ${label === "this card" ? "this card" : `<span class="dt-name">${label}</span>`}` +
    ` by turn ${turn} on the ${onPlay ? "play" : "draw"}` +
    `<span class="dt-sub"> · from ${population} cards</span>`;
  // Per-turn line: P(>=k) at turns 1..10, as horizontal bars (house .bar idiom).
  chart.innerHTML = "";
  for (let tt = 1; tt <= 10; tt++) {
    const pt = drawOddsByTurn(population, successes, k, tt, onPlay);
    const row = el("div", "dt-bar-row");
    row.classList.toggle("on", tt === turn);
    row.innerHTML =
      `<span class="dt-bar-t">T${tt}</span>` +
      `<span class="dt-bar"><span class="dt-bar-fill" style="width:${(pt * 100).toFixed(1)}%"></span></span>` +
      `<span class="dt-bar-p">${Math.round(pt * 100)}%</span>`;
    chart.appendChild(row);
  }
}

/* ---------- boot ---------- */
// Keep the browser chrome (address bar / PWA) color matched to the active theme.
function syncThemeColor() {
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.content = document.documentElement.dataset.theme === "light" ? "#efe6d3" : "#14110e";
}

async function boot() {
  syncThemeColor();      // match the chrome color to the theme the <head> script picked
  buildDashboard();
  refreshDashboard();
  wireEvents();
  recomputeDrawOdds();   // standalone calculator works before any deck is loaded
  try {
    state.lands = await loadLands();
    for (const land of state.lands) {
      land.baseColors = land.colors.slice();          // colors before any condition
      land.baseTapped = !!land.tapped;                 // tapped before any untap condition
      if (land.condition) state.conditionsPresent.add(land.condition);
      if (land.untapWhen) state.conditionsPresent.add(land.untapWhen);
    }
    buildGrid();
    const meta = await loadMeta();
    if (meta) $("#dataMeta").textContent = `${meta.lands} lands · data ${meta.generated}`;
    const pop = await loadLandPopularity();
    if (pop?.lands) setLandPopularity(pop.lands);  // tie-break recommended lands toward metagame staples
  } catch (e) {
    $("#gridCount").textContent = "Couldn't load land data";
    $("#gridEmpty").hidden = false;
    $("#gridEmpty").textContent = "Failed to load data/lands.json: " + e.message;
  }
  // A share link (deck + build in the hash) wins over the last local session.
  let handled = false;
  try { handled = await loadFromShareLink(); } catch { handled = false; }
  if (!handled) {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) { $("#deckText").value = saved; analyzeDeck(); }
  }
}

function readDeckFile(file) {
  const reader = new FileReader();
  reader.onload = () => { $("#deckText").value = reader.result; analyzeDeck(); };
  reader.readAsText(file);
}

function wireEvents() {
  $("#analyzeBtn").addEventListener("click", analyzeDeck);
  $("#exampleBtn").addEventListener("click", async () => {
    $("#deckText").value = await loadExampleDeck();
    analyzeDeck();
  });
  $("#recommendBtn").addEventListener("click", recommend);
  $("#recOptions").addEventListener("click", (e) => {
    const btn = e.target.closest(".rec-option");
    if (btn) selectRecOption(Number(btn.dataset.i));
  });
  $("#recClose").addEventListener("click", () => { hidePreview(); closeDrawer($("#recDrawer")); });
  $("#recApply").addEventListener("click", () => { hidePreview(); applyRecommendation(); });
  $("#exportBtn").addEventListener("click", openExport);
  $("#exportClose").addEventListener("click", () => closeDrawer($("#exportModal")));
  $("#shareLinkBtn").addEventListener("click", copyShareLink);
  $("#exportJsonBtn").addEventListener("click", exportAnalysisJSON);
  // Backdrop click (on the dim area, not the card) closes a drawer.
  for (const id of ["recDrawer", "exportModal"]) {
    const d = $("#" + id);
    d.addEventListener("click", (e) => { if (e.target === d) { hidePreview(); closeDrawer(d); } });
  }
  // Escape closes whatever overlay is open (drawer first, then the tweak popover).
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const rec = $("#recDrawer"), exp = $("#exportModal"), pop = $("#smoothPop"), cp = $("#costPop");
    if (!rec.hidden) { hidePreview(); closeDrawer(rec); }
    else if (!exp.hidden) closeDrawer(exp);
    else if (!cp.hidden) cp.hidden = true;
    else if (!pop.hidden) pop.hidden = true;
  });
  $("#suggestToggle").addEventListener("click", () => {
    // Flip from whatever is currently showing — auto-on while short, else off.
    const effective = state.suggest === null ? deficitColors().size > 0 : state.suggest;
    state.suggest = !effective;
    markFixers();  // markFixers owns the toggle's .on state; highlight-only (the Show control filters)
  });
  $("#raresToggle").addEventListener("click", (e) => {
    state.raresOnly = !state.raresOnly;
    e.target.classList.toggle("on", state.raresOnly);
    applyVisibility();
  });
  $("#landMode").addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (btn) setLandMode(btn.dataset.mode);
  });
  $("#gradeInfo").addEventListener("click", (e) => {
    const note = $("#gradeNote");
    note.hidden = !note.hidden;
    e.currentTarget.setAttribute("aria-expanded", String(!note.hidden));
  });
  $("#landWhy").addEventListener("click", (e) => {
    const note = $("#landWhyNote");
    note.hidden = !note.hidden;
    e.currentTarget.setAttribute("aria-expanded", String(!note.hidden));
  });
  // Draw-odds tool: every control recomputes; the (i) toggles the explainer.
  for (const id of ["drawCardSel", "drawN", "drawTurn", "drawPlay", "drawPop", "drawSucc"]) {
    const ev = (id === "drawCardSel" || id === "drawPlay") ? "change" : "input";
    $("#" + id).addEventListener(ev, recomputeDrawOdds);
  }
  $("#drawInfo").addEventListener("click", (e) => {
    const note = $("#drawInfoNote");
    note.hidden = !note.hidden;
    e.currentTarget.setAttribute("aria-expanded", String(!note.hidden));
  });
  $("#smoothMinus").addEventListener("click", () => changeSmooth(-1));
  $("#smoothPlus").addEventListener("click", () => changeSmooth(1));
  // Cost-override popover: live preview on input, apply/reset on the buttons,
  // Enter to apply.
  $("#costPopInput").addEventListener("input", renderCostPreview);
  $("#costPopInput").addEventListener("keydown", (e) => { if (e.key === "Enter") applyCostPop(); });
  $("#costPopApply").addEventListener("click", applyCostPop);
  $("#costPopReset").addEventListener("click", resetCostPop);
  // Dismiss the tweak/cost popovers on an outside click.
  document.addEventListener("click", (e) => {
    const pop = $("#smoothPop");
    if (!pop.hidden && !pop.contains(e.target) && !e.target.closest(".smooth-tag")) {
      pop.hidden = true;
    }
    const cp = $("#costPop");
    if (!cp.hidden && !cp.contains(e.target) && !e.target.closest(".cost-tag")) {
      cp.hidden = true;
    }
  });
  $("#confSel").addEventListener("change", (e) => {
    state.threshold = e.target.value ? parseFloat(e.target.value) : null;
    if ($("#deckText").value.trim()) analyzeDeck();
  });
  // Light / dark toggle. The <head> script already set data-theme (saved or system) before
  // paint; here we just flip it, persist the choice, and keep the browser chrome color in sync.
  $("#themeToggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("mtg_theme", next); } catch {}
    syncThemeColor();
  });
  // "Preview the cut": re-simulate the draw figures against the leaner build the advice
  // recommends, without touching the real build. Re-render comes via the next sim pass.
  $("#pdAdvice").addEventListener("click", (e) => {
    if (!e.target.closest("#previewCutBtn")) return;
    state.previewCut = !state.previewCut;
    scheduleSim();
  });
  $("#searchBox").addEventListener("input", (e) => {
    state.search = e.target.value.toLowerCase().trim();
    applyVisibility();
  });
  $("#sortSel").addEventListener("change", (e) => {
    state.sort = e.target.value;
    applySort();
  });
  // Drag-and-drop a .txt decklist onto the textarea.
  const drop = $("#deckText");
  ["dragover", "dragenter"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("dropping"); }));
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, () => drop.classList.remove("dropping")));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) readDeckFile(file);
  });
}

boot();
