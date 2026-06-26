import { COLORS, COLOR_NAMES } from "./colors.js";
import { costConstraints, manaValue } from "./mana.js";
import { requirementsForCards } from "./requirements.js";
import { castableProbability, multivariateCastable, grade } from "./hypergeometric.js";
import { recommend as recommendManabase, recommendLandCount } from "./recommend.js";
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
  tiles: new Map(),    // land name -> { el, land, numEl }
  spellCells: new Map(),
  lastRec: null,
  lastImportedDeck: null,  // deck text whose lands were loaded into the build
};

const $ = (s) => document.querySelector(s);
const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };
// A land if "Land" is among its card types (left of the subtype dash).
const isLandType = (type) => (type || "").split("—")[0].includes("Land");

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
  if (land.image_hi && land.image_hi !== land.image) {
    tile.addEventListener("mouseenter", () => {
      if (img.dataset.hi) return;
      img.dataset.hi = "1"; img.src = land.image_hi;
    }, { once: true });
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
}

function isVisible(land) {
  if (state.search && !land.name.toLowerCase().includes(state.search)) return false;
  if (state.raresOnly && land.rarity !== "rare" && land.rarity !== "mythic") return false;
  if (state.suggest) {
    const need = deficitColors();
    if (!land.colors.some((c) => need.has(c))) return false;
  }
  return true;
}

function applyVisibility() {
  let n = 0;
  for (const { el: tile, land } of state.tiles.values()) {
    const vis = isVisible(land);
    tile.style.display = vis ? "" : "none";
    if (vis) n++;
  }
  $("#gridCount").textContent = `${n} land${n === 1 ? "" : "s"}`;
  $("#gridEmpty").hidden = n > 0;
  $("#gridEmpty").textContent = n ? "" : "No lands match the current filters.";
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
  if (state.suggest) applyVisibility();
  markFixers();
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
        state.spells.push({ name: c.name, image: c.image, qty: qtyByName[c.name] || 1, mv, gold: cols.length > 1, pips });
      }
    }
    const avg = state.deckCards.length
      ? state.deckCards.reduce((s, c) => s + c.mv, 0) / state.deckCards.length : 3;
    state.landTarget = recommendLandCount(avg, state.deckSize);

    // Load the deck's own lands into the build so the dashboard + grades reflect
    // your actual manabase. Only when the deck text itself changes, so toggling
    // confidence (which re-analyzes) doesn't wipe lands you've adjusted by hand.
    let loadedLands = 0, landsOutsidePool = 0;
    if (text !== state.lastImportedDeck) {
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
    applyVisibility();
    gradeBuild();
    $("#recommendBtn").disabled = false;
    $("#suggestToggle").disabled = false;
    $("#exportBtn").disabled = false;
    $("#deckStatus").textContent = `${cards.length} cards · ${state.deckSize}-card deck · target ~${state.landTarget} lands`;
    const colors = COLORS.filter((c) => state.requirements[c] > 0).map((c) => COLOR_NAMES[c]);
    const parts = [colors.length ? `Needs ${colors.join(", ")} sources.` : "No colored requirements found."];
    if (loadedLands) parts.push(`Loaded ${loadedLands} lands from your deck.`);
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
    const badge = el("div", "badge");
    badge.innerHTML = `<span class="bl">–</span><span class="bp"></span>`;
    cell.append(ph, img, qty, badge);
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
      cell.querySelector(".bp").textContent = Math.round(prob * 100) + "%";
    }
    worst = Math.min(worst, prob);
  }
  const og = $("#overallGrade");
  const g = grade(worst);
  og.hidden = false;
  og.querySelector(".og-letter").textContent = g.letter;
  og.querySelector(".og-letter").style.background = `var(--grade-${g.letter})`;
  og.querySelector(".og-text").textContent = `Weakest card ${Math.round(worst * 100)}% — ${g.label}`;
}

/* ---------- recommendation (local) ---------- */
function recommend() {
  const rec = recommendManabase(state.requirements, state.lands, { landTarget: state.landTarget });
  const byName = new Map(state.lands.map((l) => [l.name, l]));
  const picks = Object.entries(rec.counts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => {
      const l = byName.get(name) || {};
      return { name, count, colors: l.colors || [] };
    });
  const list = $("#recList");
  list.innerHTML = "";
  for (const p of picks) {
    const row = el("div", "rec-row");
    const dots = p.colors.map((c) => `<i style="background:var(--${c})"></i>`).join("");
    row.innerHTML = `<span class="rc">${p.count}×</span><span class="rn">${p.name}</span><span class="rd">${dots}</span>`;
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
  $("#recClose").addEventListener("click", () => { $("#recDrawer").hidden = true; });
  $("#recApply").addEventListener("click", applyRecommendation);
  $("#exportBtn").addEventListener("click", exportDecklist);
  $("#exportClose").addEventListener("click", () => { $("#exportModal").hidden = true; });
  $("#suggestToggle").addEventListener("click", (e) => {
    state.suggest = !state.suggest;
    e.target.classList.toggle("on", state.suggest);
    markFixers(); applyVisibility();
  });
  $("#raresToggle").addEventListener("click", (e) => {
    state.raresOnly = !state.raresOnly;
    e.target.classList.toggle("on", state.raresOnly);
    applyVisibility();
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
