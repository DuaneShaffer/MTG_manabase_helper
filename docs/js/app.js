import { COLORS, COLOR_NAMES } from "./colors.js";
import { costConstraints, manaValue } from "./mana.js";
import { requirementsForCards } from "./requirements.js";
import { castableProbability, multivariateCastable, grade } from "./hypergeometric.js";
import { recommend as recommendManabase, recommendLandCount } from "./recommend.js";
import { simulateDeck } from "./montecarlo.js";
import { parseDeckText, deckEntries, cardNames } from "./decklist.js";
import { loadLands, loadMeta, resolveDeck, loadExampleDeck } from "./data.js";

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
  landMode: "all",     // relevant | mycolors | utility | all
  tiles: new Map(),    // land name -> { el, land, numEl }
  spellCells: new Map(),
  lastRec: null,
  lastImportedDeck: null,  // deck text whose lands were loaded into the build
  avgMV: 3,
  smoothCards: [],     // [{name, qty}] cheap draw/ramp cards in the deck
  smoothOverrides: {}, // name -> copies counted toward draw/ramp stats
  conditionsPresent: new Set(),  // condition keywords across the land pool
  conditionsActive: new Set(),   // conditions the loaded deck satisfies
};

const COND_THRESHOLD = 6;  // a conditional land "turns on" at this many matching deck cards

function smoothCount() {
  return state.smoothCards.reduce(
    (s, c) => s + (state.smoothOverrides[c.name] ?? c.qty), 0);
}

const $ = (s) => document.querySelector(s);
const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };
// A land if "Land" is among its card types (left of the subtype dash).
const isLandType = (type) => (type || "").split("—")[0].includes("Land");

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
  if (!state.landTarget) { row.hidden = true; return; }
  row.hidden = false;
  $("#recTarget").textContent = "~" + state.landTarget;
  const base = recommendLandCount(state.avgMV, state.deckSize, 0);
  const delta = base - state.landTarget;
  const sc = smoothCount();
  let why = `Karsten's curve for an average mana value of ${state.avgMV.toFixed(1)}`;
  if (sc && delta > 0) why += `, minus ~${delta} for ${sc} cheap draw/ramp card${sc === 1 ? "" : "s"} (↻)`;
  why += `. Aggro leans to the low end, control to the high end.`;
  $("#landWhyNote").textContent = why;
}

/* ---------- draw/ramp tweak popover ---------- */
let _smoothPopName = null;
function openSmoothPop(name, qty, anchorEl) {
  _smoothPopName = name;
  const pop = $("#smoothPop");
  $("#smoothPopTitle").textContent = name;
  $("#smoothCountVal").textContent = state.smoothOverrides[name] ?? qty;
  $("#smoothOf").textContent = `of ${qty} cop${qty === 1 ? "y" : "ies"} count toward the land target & Simulate.`;
  const r = anchorEl.getBoundingClientRect();
  pop.style.left = Math.min(window.innerWidth - 224, Math.max(6, r.left - 100)) + "px";
  pop.style.top = (r.bottom + 6) + "px";
  pop.hidden = false;
}
function changeSmooth(delta) {
  const card = state.smoothCards.find((c) => c.name === _smoothPopName);
  if (!card) return;
  const cur = state.smoothOverrides[card.name] ?? card.qty;
  const next = Math.max(0, Math.min(card.qty, cur + delta));
  state.smoothOverrides[card.name] = next;
  $("#smoothCountVal").textContent = next;
  state.landTarget = recommendLandCount(state.avgMV, state.deckSize, smoothCount());
  updateLandPanel();
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
      if (!/Land/.test(c.type)) state.deckCards.push({ name: c.name, mv });
      const cons = costConstraints(c.cost);
      const cols = Object.keys(cons);
      if (cols.length) {
        const pips = {};
        for (const col of cols) pips[col] = cons[col].pips;
        state.spells.push({ name: c.name, image: c.image, qty: qtyByName[c.name] || 1, mv, gold: cols.length > 1, pips, smooth: !!c.smooth });
      }
    }
    const avg = state.deckCards.length
      ? state.deckCards.reduce((s, c) => s + c.mv, 0) / state.deckCards.length : 3;
    state.avgMV = avg;
    const newDeck = text !== state.lastImportedDeck;

    // Cheap draw/ramp cards (feed the land formula + sim); reset per-card overrides
    // on a new deck.
    state.smoothCards = cards
      .filter((c) => c.smooth && !isLandType(c.type))
      .map((c) => ({ name: c.name, qty: qtyByName[c.name] || 0 }));
    if (newDeck) state.smoothOverrides = {};

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
    refreshDashboard();
    renderSpellStrip();
    markFixers();
    setLandMode(deckColors().size ? "relevant" : "all");
    updateLandPanel();
    gradeBuild();
    $("#recommendBtn").disabled = false;
    $("#suggestToggle").disabled = false;
    $("#exportBtn").disabled = false;
    $("#deckStatus").textContent = `${cards.length} cards · ${state.deckSize}-card deck · target ~${state.landTarget} lands`;
    const colors = COLORS.filter((c) => state.requirements[c] > 0).map((c) => COLOR_NAMES[c]);
    const parts = [colors.length ? `Needs ${colors.join(", ")} sources.` : "No colored requirements found."];
    if (loadedLands) parts.push(`Loaded ${loadedLands} lands from your deck.`);
    const sc = smoothCount();
    if (sc) {
      const delta = recommendLandCount(avg, state.deckSize, 0) - state.landTarget;
      parts.push(`${sc} draw/ramp cards (↻)` +
        (delta > 0 ? ` trim ~${delta} land${delta === 1 ? "" : "s"} off the target.` : ` factored into the target.`));
    }
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
  if (!state.spells.length) { strip.hidden = true; return; }
  strip.hidden = false;
  for (const spell of state.spells) {
    const cell = el("div", "spell");
    const ph = el("div", "sph"); ph.textContent = spell.name;
    const img = el("img"); img.alt = spell.name; img.loading = "lazy";
    img.addEventListener("load", () => img.classList.add("loaded"));
    if (spell.image) img.src = spell.image;
    const qty = el("span", "qty"); qty.textContent = spell.qty + "×";
    const badge = el("div", "badge");           // static (Karsten) grade — bottom-right
    badge.innerHTML = `<span class="bl">–</span><span class="bp"></span>`;
    const simPill = el("div", "sim-pill");      // simulated grade — bottom-left, after Simulate
    simPill.hidden = true;
    simPill.innerHTML = `sim <span class="sp-p"></span>`;
    cell.append(ph, img, qty, badge, simPill);
    if (spell.smooth) {                          // card draw / ramp — affects land count + sim
      const tag = el("button", "smooth-tag");
      tag.textContent = "↻";
      tag.title = "Card draw / ramp — lowers the recommended land count and helps the simulation. Click to adjust how many copies count.";
      tag.addEventListener("click", (e) => { e.stopPropagation(); openSmoothPop(spell.name, spell.qty, tag); });
      cell.appendChild(tag);
    }
    grid.appendChild(cell);
    state.spellCells.set(spell.name, cell);
  }
}

let _gradeTimer = null;
function gradeBuild() {
  if (!state.spells.length) return;
  clearTimeout(_gradeTimer);
  _gradeTimer = setTimeout(doGrade, 90);  // debounce rapid clicks (compute is local+cached)
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
    const g = grade(prob);
    const cell = state.spellCells.get(spell.name);
    if (cell) {
      cell.dataset.g = g.letter;
      cell.querySelector(".bl").textContent = g.letter;
      cell.querySelector(".bp").textContent = pct(prob);
      cell.querySelector(".sim-pill").hidden = true;  // sim is stale once the build changes
    }
    worst = Math.min(worst, prob);
  }
  state.staticWorst = worst;
  const og = $("#overallGrade");
  const g = grade(worst);
  og.hidden = false;
  og.querySelector(".og-letter").textContent = g.letter;
  og.querySelector(".og-letter").style.background = `var(--grade-${g.letter})`;
  og.querySelector(".og-text").textContent = `Weakest card ${pct(worst)} — ${g.label} · Simulate for true odds`;
}

// Display percentage, capped at 99% — the closed-form model conditions on hitting
// your land drops (it measures colour reliability, not raw mana screw), so nothing
// is 100%. The simulator is also capped for consistency.
function pct(p) {
  return Math.min(99, Math.round(p * 100)) + "%";
}

/* ---------- Monte-Carlo validator (on demand; includes mana screw) ---------- */
function runSimulation() {
  if (!state.spells.length) return;
  clearTimeout(_gradeTimer);  // cancel the debounce…
  doGrade();                  // …and refresh the static grades now, so both are shown
  const btn = $("#simBtn");
  btn.disabled = true;
  btn.textContent = "Simulating…";
  // Defer so the button label paints before the (synchronous) sim runs.
  setTimeout(() => {
    const lands = [];
    for (const { land } of state.tiles.values()) {
      const c = state.counts[land.name] || 0;
      if (c) lands.push({ colors: land.colors, tapped: !!land.tapped, count: c });
    }
    const res = simulateDeck(state.spells, lands, state.deckSize, { trials: 5000, drawCount: smoothCount() });
    // Populate the simulated pill on each card — the static badge stays as-is, so
    // both numbers are visible side by side.
    for (const spell of state.spells) {
      const p = res.bySpell[spell.name];
      const g = grade(p);
      const cell = state.spellCells.get(spell.name);
      if (!cell) continue;
      const pill = cell.querySelector(".sim-pill");
      pill.dataset.g = g.letter;
      pill.querySelector(".sp-p").textContent = pct(p);
      pill.hidden = false;
    }
    // Overall: show static (assumes lands) alongside simulated (includes screw).
    const og = $("#overallGrade");
    const sg = grade(res.overall);
    og.hidden = false;
    og.querySelector(".og-letter").textContent = sg.letter;
    og.querySelector(".og-letter").style.background = `var(--grade-${sg.letter})`;
    og.querySelector(".og-text").textContent =
      `Weakest: ${pct(state.staticWorst != null ? state.staticWorst : res.overall)} static · ` +
      `${pct(res.overall)} simulated (${res.trials / 1000}k games, incl. screw)`;
    btn.textContent = "Re-simulate";
    btn.disabled = false;
  }, 20);
}

/* ---------- recommendation (local) ---------- */
function recommend() {
  const rec = recommendManabase(state.requirements, state.lands, { landTarget: state.landTarget });
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
  const short = Object.keys(rec.shortfall || {});
  $("#recSummary").textContent = `${rec.total} lands · ${rec.taplands} tapped` +
    (short.length ? ` · still short on ${short.join(", ")}` : " · every color covered");
  state.lastRec = picks;
  $("#recDrawer").hidden = false;
}

function applyRecommendation() {
  if (!state.lastRec) return;
  state.counts = {};
  for (const p of state.lastRec) state.counts[p.name] = p.count;
  $("#recDrawer").hidden = true;
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
  $("#exportModal").hidden = false;
  navigator.clipboard?.writeText(text).then(
    () => { $("#exportCopied").textContent = "Copied to clipboard."; },
    () => { $("#exportCopied").textContent = ""; },
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
  $("#recClose").addEventListener("click", () => { $("#recDrawer").hidden = true; hidePreview(); });
  $("#recApply").addEventListener("click", () => { hidePreview(); applyRecommendation(); });
  $("#exportBtn").addEventListener("click", exportDecklist);
  $("#exportClose").addEventListener("click", () => { $("#exportModal").hidden = true; });
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
  $("#simBtn").addEventListener("click", runSimulation);
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
