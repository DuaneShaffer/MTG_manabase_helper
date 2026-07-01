// Shareable-URL codec + payload sanitizing for the Export drawer's share link.
// Lives apart from app.js (which is DOM-coupled) so the encode/decode round-trip
// and the payload validation are testable in Node.
//
// A decoded payload is attacker-controlled text — share links auto-analyze on
// open — so every field is validated/clamped here before it touches app state.

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

// A compressed ("z") link opened in a browser without DecompressionStream can't
// be decoded at all — callers surface this case instead of failing silently.
export class UnsupportedShareError extends Error {}

export async function encodeShare(payload) {
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

export async function decodeShare(hash) {
  const tag = hash[0], body = hash.slice(1);
  if (tag === "u") return JSON.parse(decodeURIComponent(body));
  if (tag === "z") {
    if (typeof DecompressionStream !== "function") {
      throw new UnsupportedShareError("this browser can't decompress share links");
    }
    const ds = new DecompressionStream("deflate-raw");
    const writer = ds.writable.getWriter();
    writer.write(_b64u.dec(body)); writer.close();
    const text = await new Response(ds.readable).text();
    return JSON.parse(text);
  }
  return null;
}

// Land counts from a payload, clamped to what the app itself allows (0–4 for
// non-basics, non-negative for basics — the changeCount rule). Unknown lands and
// non-numeric counts are dropped, never thrown. `landFor` maps name -> land|null.
export function clampLandCounts(lands, landFor) {
  const counts = {};
  if (!lands || typeof lands !== "object") return counts;
  for (const [name, v] of Object.entries(lands)) {
    const land = landFor(name);
    const n = Math.floor(Number(v));
    if (!land || !Number.isFinite(n) || n <= 0) continue;
    counts[name] = Math.min(n, land.basic ? 60 : 4);
  }
  return counts;
}

// The confidence threshold must be one of the app's own numeric choices (a
// string in state.threshold breaks sourcesNeeded comparisons). Returns the
// coerced number, or null for absent/invalid — callers keep their default.
export function coerceConf(conf, allowed) {
  if (conf == null) return null;
  const n = Number(conf);
  if (!Number.isFinite(n)) return null;
  return allowed.some((a) => Math.abs(a - n) < 1e-9) ? n : null;
}

// Per-card copy overrides (the draw/ramp "count as" tweaks): keep only names the
// analyzed deck actually flagged, each clamped to 0..that card's copies.
export function clampCopyOverrides(src, cards) {
  const out = {};
  if (!src || typeof src !== "object") return out;
  for (const c of cards || []) {
    if (!(c.name in src)) continue;
    const v = Math.floor(Number(src[c.name]));
    if (Number.isFinite(v)) out[c.name] = Math.max(0, Math.min(c.qty, v));
  }
  return out;
}

// Cost overrides are mana-cost strings fed to parseCost (which ignores junk
// tokens); keep only short non-empty strings so a malformed payload can't
// smuggle anything else into state.
export function sanitizeCostOverrides(src) {
  const out = {};
  if (!src || typeof src !== "object") return out;
  for (const [name, v] of Object.entries(src)) {
    if (typeof v === "string" && v && v.length <= 60) out[name] = v;
  }
  return out;
}
