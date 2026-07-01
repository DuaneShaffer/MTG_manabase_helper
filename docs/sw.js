// Service worker — makes the app work offline (it's installable via manifest.json).
//
// VERSION discipline: bump VERSION when shipping js/css/html changes, or the
// precached shell keeps serving the old code until the browser re-checks.
// The weekly data refresh does NOT need a bump — data/*.json is served
// stale-while-revalidate, so new snapshots propagate on the next online visit.
//
// All precache URLs are relative so the project-pages path
// (/MTG_manabase_helper/) resolves correctly.

const VERSION = "2026-07-01";
const SHELL_CACHE = "mb-shell-" + VERSION;   // app shell + data snapshots (versioned)
const FONT_CACHE = "mb-fonts-v1";            // Google Fonts (persistent)
const IMAGE_CACHE = "mb-images-v1";          // Scryfall card images (persistent, capped)
const IMAGE_CACHE_MAX = 200;

const PRECACHE = [
  "./",
  "app.html",
  "index.html",
  "styles.css",
  "landing.css",
  "manifest.json",
  "favicon.svg",
  "example_deck.txt",
  "js/advice.js",
  "js/app.js",
  "js/colors.js",
  "js/data.js",
  "js/decklist.js",
  "js/hypergeometric.js",
  "js/mana.js",
  "js/montecarlo.js",
  "js/optimize.js",
  "js/recommend.js",
  "js/requirements.js",
  "js/share.js",
  "js/vendor/lp-solver.js",
  "data/lands.json",
  "data/cards.json",
  "data/meta.json",
  "data/land_popularity.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  const keep = new Set([SHELL_CACHE, FONT_CACHE, IMAGE_CACHE]);
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n.startsWith("mb-") && !keep.has(n)).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

// A response worth caching: OK, or opaque (no-cors font/image fetches report status 0).
function cacheable(resp) {
  return resp && (resp.ok || resp.type === "opaque");
}

// Cache-first: serve from cache, else fetch and remember the result.
async function cacheFirst(request, cacheName, ignoreSearch) {
  const cached = await caches.match(request, { ignoreSearch: !!ignoreSearch });
  if (cached) return cached;
  const resp = await fetch(request);
  if (cacheable(resp)) {
    const cache = await caches.open(cacheName);
    cache.put(request, resp.clone());
  }
  return resp;
}

// Stale-while-revalidate: serve the cached copy immediately, refresh it in the
// background so the weekly data update lands on the *next* visit.
async function staleWhileRevalidate(request, event) {
  const cached = await caches.match(request);
  const refresh = fetch(request)
    .then(async (resp) => {
      if (cacheable(resp)) {
        const cache = await caches.open(SHELL_CACHE);
        await cache.put(request, resp.clone());
      }
      return resp;
    })
    .catch(() => undefined);
  if (cached) {
    event.waitUntil(refresh);
    return cached;
  }
  const resp = await refresh;
  if (resp) return resp;
  return Response.error();
}

// Runtime image cache with a simple cap: once full, drop the oldest entries.
async function cappedImageCache(request) {
  const cache = await caches.open(IMAGE_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const resp = await fetch(request);
  if (cacheable(resp)) {
    await cache.put(request, resp.clone());
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - IMAGE_CACHE_MAX; i++) await cache.delete(keys[i]);
  }
  return resp;
}

// Network-first with cache fallback, for anything not covered above.
async function networkFallingBackToCache(request) {
  try {
    return await fetch(request);
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;  // never touch POST (Scryfall collection fallback) etc.

  const url = new URL(request.url);

  // Card images: runtime cache, capped — the pool is far too large to precache.
  if (url.hostname === "cards.scryfall.io") {
    event.respondWith(cappedImageCache(request));
    return;
  }

  // Google Fonts (stylesheet + woff2): cache-first; opaque responses are fine.
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(cacheFirst(request, FONT_CACHE));
    return;
  }

  if (url.origin === self.location.origin) {
    // Data snapshots: stale-while-revalidate so the weekly refresh propagates
    // without a VERSION bump and without ever breaking offline.
    if (url.pathname.includes("/data/") && url.pathname.endsWith(".json")) {
      event.respondWith(staleWhileRevalidate(request, event));
      return;
    }
    // Shell assets and navigations: cache-first (ignore query strings on
    // navigations so a URL with parameters still hits the precached page).
    event.respondWith(cacheFirst(request, SHELL_CACHE, request.mode === "navigate"));
    return;
  }

  // Everything else (e.g. api.scryfall.com GETs): network, cache as fallback only.
  event.respondWith(networkFallingBackToCache(request));
});
