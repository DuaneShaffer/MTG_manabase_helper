import { COLORS, COLOR_NAMES } from "./colors.js";
import { costConstraints, manaValue } from "./mana.js";
import { requirementsForCards } from "./requirements.js";
import { castableProbability, multivariateCastable, grade } from "./hypergeometric.js";
import { recommend as recommendManabase, recommendLandCount } from "./recommend.js";
import { optimizeManabase, OBJECTIVES, setLandPopularity } from "./optimize.js";
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
  suggest: false,
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
        <div class="bar-label">${COLOR_NAMES[c]}</div>
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
  const need = state.suggest ? deficitColors() : null;
  for (const { el: tile, land } of state.tiles.values()) {
    tile.classList.toggle("fixer", !!need && land.colors.some((c) => need.has(c)));
  }
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
  for (const cond of state.conditionsPresent) counts[cond] = 0;
  for (const c of cards) {
    if (isLandType(c.type)) continue;
    const t = (c.type || "").toLowerCase();
    const q = qtyByName[c.name] || 0;
    for (const cond of state.conditionsPresent) {
      // a condition like "instant or sorcery" matches a card of either type
      if (cond.split(" or ").some((p) => t.includes(p))) counts[cond] += q;
    }
  }
  state.conditionsActive = new Set(
    [...state.conditionsPresent].filter((cond) => counts[cond] >= COND_THRESHOLD));
  // Set each conditional land's effective colors and refresh its tile.
  for (const land of state.lands) {
    if (!land.condition) continue;
    const eff = state.conditionsActive.has(land.condition)
      ? [...new Set([...land.baseColors, ...(land.condColors || [])])]
      : land.baseColors;
    if ((land.colors || []).join() !== eff.join()) {
      land.colors = eff.slice();
      refreshTileDots(land);
    }
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
    ? `of ${qty} ${cops} dig toward lands in Simulate (they don't change your land count).`
    : `of ${qty} ${cops} count toward the land target & Simulate.`;
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
    state.requirements = requirementsForCards(cards.map((c) => ({ cost: c.cost })), state.deckSize, state.threshold);

    state.spells = [];
    state.deckCards = [];
    for (const c of cards) {
      const mv = manaValue(c.cost);
      if (!isLandType(c.type)) state.deckCards.push({ name: c.name, mv });  // transform DFCs are spells on the curve
      const cons = costConstraints(c.cost);
      const cols = Object.keys(cons);
      if (cols.length) {
        const pips = {};
        for (const col of cols) pips[col] = cons[col].pips;
        const cheap = !!c.smooth && mv <= SMOOTH_MAX_MV;  // smooths early drops -> trims lands
        const dig = !!c.smooth && mv > SMOOTH_MAX_MV;     // 3 MV card advantage -> helps the top end
        state.spells.push({ name: c.name, image: c.image, qty: qtyByName[c.name] || 1, mv, gold: cols.length > 1, pips, smooth: cheap, dig });
      }
    }
    const avg = state.deckCards.length
      ? state.deckCards.reduce((s, c) => s + c.mv, 0) / state.deckCards.length : 3;
    state.avgMV = avg;

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
    const newDeck = text !== state.lastImportedDeck;

    // Split draw/ramp by mana value: cheap (<=2 MV) smooths early drops and trims
    // the land target; mid-cost (3 MV) is card advantage that only helps the sim
    // reach lands for expensive spells. Reset per-card overrides on a new deck.
    const drawRamp = cards.filter((c) => c.smooth && !isLandType(c.type));
    state.smoothCards = drawRamp
      .filter((c) => manaValue(c.cost) <= SMOOTH_MAX_MV)
      .map((c) => ({ name: c.name, qty: qtyByName[c.name] || 0 }));
    state.digCards = drawRamp
      .filter((c) => manaValue(c.cost) > SMOOTH_MAX_MV)
      .map((c) => ({ name: c.name, qty: qtyByName[c.name] || 0 }));
    if (newDeck) { state.smoothOverrides = {}; state.digOverrides = {}; }

    // Conditional fixing: turn on lands whose spell-type condition the deck meets.
    applyConditions(cards, qtyByName);

    state.landTarget = recommendLandCount(avg, state.deckSize, smoothCount());

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
      const delta = recommendLandCount(avg, state.deckSize, 0) - state.landTarget;
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
  grid.innerHTML = "";
  state.spellCells = new Map();
  if (!state.spells.length) { strip.hidden = true; $("#hudGrade").hidden = true; return; }
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
    // Simulated reading — the clock icon flags it as the LANDS-ON-TIME %.
    const simPill = el("div", "sim-pill");
    simPill.hidden = true;
    simPill.innerHTML =
      `<svg class="axis-ico timing" viewBox="0 0 16 16" role="img" aria-label="Real games: lands on time"><title>Real games: do you draw enough lands, on time? True on-curve odds including mana screw &amp; flood.</title>` +
      `<circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" stroke-width="1.4"/>` +
      `<path d="M8 8 L8 4.2 M8 8 L10.7 9.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>` +
      `<span class="sp-p"></span>`;
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
    grid.appendChild(cell);
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

function doGrade() {
  const t = tally();
  const sources = { W: t.W, U: t.U, B: t.B, R: t.R, G: t.G };
  let worst = 1;
  for (const spell of state.spells) {
    const cols = Object.keys(spell.pips);
    let prob;
    if (cols.length <= 1) {
      const c = cols[0];
      prob = c ? castableProbability(spell.pips[c], spell.mv, sources[c], state.deckSize, t.total) : 1;
    } else {
      const srcByColor = {};
      for (const c of cols) srcByColor[c] = sources[c];
      prob = multivariateCastable(spell.pips, spell.mv, srcByColor, state.deckSize, t.total);
    }
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
}

// Display percentage, capped at 99% — the closed-form model conditions on hitting
// your land drops (it measures colour reliability, not raw mana screw), so nothing
// is 100%. The simulator is also capped for consistency.
function pct(p) {
  return Math.min(99, Math.round(p * 100)) + "%";
}

/* ---------- Monte-Carlo validator (auto, lazy; includes mana screw) ---------- */
// Runs itself a beat after the model grades, during idle time, so the true
// (screw-aware) odds stay current without the user pressing anything.
function scheduleSim() {
  clearTimeout(_simTimer);
  _simTimer = setTimeout(() => idle(doSimulate), 130);
}
function doSimulate() {
  if (!state.spells.length) return;
  const lands = [];
  for (const { land } of state.tiles.values()) {
    const c = state.counts[land.name] || 0;
    if (c) lands.push({ colors: land.colors, tapped: !!land.tapped, count: c });
  }
  // Both cheap smoothers and mid-cost diggers help you find lands in a real game.
  const res = simulateDeck(state.spells, lands, state.deckSize, { trials: 5000, drawCount: smoothCount() + digCount() });
  // Refresh the simulated pill on each card — the model badge stays as-is, so both
  // readings are visible together.
  for (const spell of state.spells) {
    const p = res.bySpell[spell.name];
    const cell = state.spellCells.get(spell.name);
    if (!cell) continue;
    const pill = cell.querySelector(".sim-pill");
    pill.dataset.g = grade(p).letter;   // tint only
    pill.querySelector(".sp-p").textContent = pct(p);
    pill.hidden = false;
  }
  // Overall headline = the true (simulated) weakest; the model figure rides along as context.
  $("#hudGrade").hidden = false;
  const og = $("#overallGrade");
  const ogl = og.querySelector(".og-letter");
  ogl.textContent = pct(res.overall);
  ogl.dataset.g = grade(res.overall).letter;
  og.querySelector(".og-text").textContent =
    `Weakest card in real games, incl. screw · ${pct(state.staticWorst != null ? state.staticWorst : res.overall)} on colors alone`;
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
  const seen = new Set();
  for (const r of results) {
    if (!r || !r.rec.feasible) continue;
    const sig = _sig(r.rec);
    if (seen.has(sig)) continue;
    seen.add(sig);
    options.push({ label: OBJECTIVES[r.objective].label, rec: r.rec });
  }
  return options;
}

// Build the "Suggested" filter set: every land any optimal base reaches for, plus
// on-color basics (always a tuning lever). These are the same picks Build manabase
// offers — narrowing the full pool to what the recommender would actually run.
let _suggestRun = 0;
async function computeSuggested() {
  const run = ++_suggestRun;
  try {
    const options = await computeRecOptions();
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
    const options = await computeRecOptions();
    if (run !== _recRun) return;  // superseded by a newer open/recompute

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

// Render the selectable list of computed options (name + headline stats).
function renderRecOptions(options) {
  const wrap = $("#recOptions");
  wrap.innerHTML = "";
  options.forEach((opt, i) => {
    const btn = el("button", "rec-option");
    btn.dataset.i = i;
    btn.innerHTML =
      `<span class="ro-name">${opt.label}</span>` +
      `<span class="ro-stat">${opt.rec.total} lands · ${opt.rec.taplands} tapped</span>`;
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

function selectRecOption(i) {
  const opt = state.recOptions[i];
  if (!opt) return;
  for (const b of document.querySelectorAll("#recOptions .rec-option")) {
    b.classList.toggle("on", Number(b.dataset.i) === i);
  }
  const note = state.recOptions.length > 1 ? "optimal for this goal — " + opt.label.toLowerCase() : opt.label.toLowerCase();
  renderRecList(opt.rec, `${opt.rec.total} lands · ${opt.rec.taplands} tapped · ${note}${_shortNote(opt.rec)}`);
  $("#recApply").disabled = false;
}

function recommend() {
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

/* ---------- export the build as a decklist ---------- */
function exportDecklist() {
  const lines = [];
  if (state.spells.length || state.deckCards.length) {
    // include the analyzed nonland deck cards (with their quantities)
    const spellByName = new Map(state.spells.map((s) => [s.name, s]));
    lines.push("// Spells");
    for (const c of state.deckCards) {
      const s = spellByName.get(c.name);
      lines.push(`${s ? s.qty : 1} ${c.name}`);
    }
    lines.push("");
  }
  lines.push("// Lands");
  const land = [];
  for (const l of state.lands) {
    const n = state.counts[l.name] || 0;
    if (n) land.push(`${n} ${l.name}`);
  }
  lines.push(...(land.length ? land : ["(no lands added yet)"]));
  const text = lines.join("\n");
  $("#exportText").value = text;
  $("#exportCopied").textContent = "";
  openDrawer($("#exportModal"));
  navigator.clipboard?.writeText(text).then(
    () => { $("#exportCopied").textContent = "Copied to clipboard."; },
    () => { $("#exportCopied").textContent = "Select all and copy."; },
  );
}

/* ---------- boot ---------- */
async function boot() {
  buildDashboard();
  refreshDashboard();
  wireEvents();
  try {
    state.lands = await loadLands();
    for (const land of state.lands) {
      land.baseColors = land.colors.slice();          // colors before any condition
      if (land.condition) state.conditionsPresent.add(land.condition);
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
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) { $("#deckText").value = saved; analyzeDeck(); }
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
  $("#exportBtn").addEventListener("click", exportDecklist);
  $("#exportClose").addEventListener("click", () => closeDrawer($("#exportModal")));
  // Backdrop click (on the dim area, not the card) closes a drawer.
  for (const id of ["recDrawer", "exportModal"]) {
    const d = $("#" + id);
    d.addEventListener("click", (e) => { if (e.target === d) { hidePreview(); closeDrawer(d); } });
  }
  // Escape closes whatever overlay is open (drawer first, then the tweak popover).
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const rec = $("#recDrawer"), exp = $("#exportModal"), pop = $("#smoothPop");
    if (!rec.hidden) { hidePreview(); closeDrawer(rec); }
    else if (!exp.hidden) closeDrawer(exp);
    else if (!pop.hidden) pop.hidden = true;
  });
  $("#suggestToggle").addEventListener("click", (e) => {
    state.suggest = !state.suggest;
    e.target.classList.toggle("on", state.suggest);
    markFixers();  // highlight-only now; the Show control owns filtering
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
  $("#smoothMinus").addEventListener("click", () => changeSmooth(-1));
  $("#smoothPlus").addEventListener("click", () => changeSmooth(1));
  // Dismiss the tweak popover on an outside click.
  document.addEventListener("click", (e) => {
    const pop = $("#smoothPop");
    if (!pop.hidden && !pop.contains(e.target) && !e.target.closest(".smooth-tag")) {
      pop.hidden = true;
    }
  });
  $("#confSel").addEventListener("change", (e) => {
    state.threshold = e.target.value ? parseFloat(e.target.value) : null;
    if ($("#deckText").value.trim()) analyzeDeck();
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
