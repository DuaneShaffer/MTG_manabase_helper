// Tests for the share-link codec + payload sanitizing (share.js). Node 18+ has
// CompressionStream/DecompressionStream, so the compressed round-trip runs for
// real; the fallback paths are exercised by hiding the globals.
import assert from "assert";
import {
  encodeShare, decodeShare, UnsupportedShareError,
  clampLandCounts, coerceConf, clampCopyOverrides, sanitizeCostOverrides,
  buildStatePayload, parseStoredValue,
} from "../share.js";

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log("ok - " + name); passed++; };

const V2 = {
  v: 2, deck: "4 Lightning Strike\n4 Hearth Elemental", conf: 0.95,
  lands: { Mountain: 20, "Restless Vents": 4 },
  costOverrides: { "Torch the Tower": "{1}{R}{R}" },
  smooth: { "Stock Up": 2 }, dig: { "Deduce": 1 },
};

// 1. Compressed ("z") round-trip preserves the full v2 payload.
{
  const hash = await encodeShare(V2);
  ok("compressed link carries the 'z' tag", hash[0] === "z");
  assert.deepStrictEqual(await decodeShare(hash), V2);
  ok("z round-trip is lossless (incl. overrides)", true);
}

// 2. Plain ("u") fallback when CompressionStream is unavailable.
{
  const CS = globalThis.CompressionStream;
  delete globalThis.CompressionStream;
  const hash = await encodeShare(V2);
  globalThis.CompressionStream = CS;
  ok("plain fallback carries the 'u' tag", hash[0] === "u");
  assert.deepStrictEqual(await decodeShare(hash), V2);
  ok("u round-trip is lossless", true);
}

// 3. A "z" link without DecompressionStream fails LOUDLY with the typed error.
{
  const hash = await encodeShare(V2);
  const DS = globalThis.DecompressionStream;
  delete globalThis.DecompressionStream;
  let err = null;
  try { await decodeShare(hash); } catch (e) { err = e; }
  globalThis.DecompressionStream = DS;
  ok("missing DecompressionStream throws UnsupportedShareError", err instanceof UnsupportedShareError);
}

// 4. A v1 payload (no overrides fields) still decodes, and the sanitizers treat
// the absent fields as empty rather than throwing.
{
  const v1 = { v: 1, deck: "20 Island", conf: null, lands: { Island: 20 } };
  const back = await decodeShare(await encodeShare(v1));
  assert.deepStrictEqual(back, v1);
  ok("v1 payload round-trips", true);
  ok("absent overrides sanitize to empty", Object.keys(sanitizeCostOverrides(back.costOverrides)).length === 0
    && Object.keys(clampCopyOverrides(back.smooth, [{ name: "Stock Up", qty: 4 }])).length === 0);
  ok("v1 conf:null is left unset", coerceConf(back.conf, [0.9, 0.95, 0.99]) === null);
}

// 5. Land counts: unknown lands dropped, values coerced to legal integers.
{
  const pool = {
    Mountain: { name: "Mountain", basic: true },
    "Restless Vents": { name: "Restless Vents", basic: false },
  };
  const counts = clampLandCounts({
    Mountain: 22,                 // basics may exceed 4
    "Restless Vents": 9,          // non-basics clamp to 4
    "Fake Land": 4,               // not in the pool -> dropped
    __proto__: null,
  }, (n) => pool[n] || null);
  assert.deepStrictEqual(counts, { Mountain: 22, "Restless Vents": 4 });
  ok("land counts clamp to the pool's legal quantities", true);
  const junk = clampLandCounts({ Mountain: -3, "Restless Vents": "lots" }, (n) => pool[n] || null);
  ok("negative and non-numeric counts are dropped", Object.keys(junk).length === 0);
  ok("float counts floor to integers", clampLandCounts({ Mountain: 2.9 }, (n) => pool[n]).Mountain === 2);
  ok("non-object lands field yields no counts", Object.keys(clampLandCounts("evil", () => null)).length === 0);
}

// 6. Confidence: only the app's own numeric choices pass; strings coerce.
{
  const ALLOWED = [0.9, 0.95, 0.99];
  ok("numeric string coerces to its number", coerceConf("0.95", ALLOWED) === 0.95);
  ok("a value outside the choices is rejected", coerceConf(0.5, ALLOWED) === null);
  ok("garbage is rejected", coerceConf("high", ALLOWED) === null && coerceConf({}, ALLOWED) === null);
}

// 7. Copy overrides clamp to each card's actual copies.
{
  const cards = [{ name: "Stock Up", qty: 4 }, { name: "Deduce", qty: 2 }];
  const out = clampCopyOverrides({ "Stock Up": 9, Deduce: -1, "Not Here": 3 }, cards);
  assert.deepStrictEqual(out, { "Stock Up": 4, Deduce: 0 });
  ok("copy overrides clamp to 0..qty and drop unknown names", true);
}

// 8. Cost overrides keep only short non-empty strings.
{
  const out = sanitizeCostOverrides({ A: "{1}{R}", B: 7, C: "", D: "x".repeat(99) });
  assert.deepStrictEqual(out, { A: "{1}{R}" });
  ok("cost overrides keep only sane strings", true);
}

// 9. buildStatePayload emits the v2 share shape (and copies, never aliases).
{
  const lands = { ...V2.lands };
  const p = buildStatePayload({
    deck: V2.deck, conf: 0.95, lands,
    costOverrides: V2.costOverrides, smooth: V2.smooth, dig: V2.dig,
  });
  assert.deepStrictEqual(p, V2);
  ok("buildStatePayload matches the v2 share payload shape", true);
  lands.Mountain = 7;
  ok("payload copies its inputs (later state edits don't mutate it)", p.lands.Mountain === 20);
  const bare = buildStatePayload({ deck: "20 Island" });
  ok("absent fields default to null conf + empty objects",
    bare.conf === null && Object.keys(bare.lands).length === 0
    && Object.keys(bare.costOverrides).length === 0
    && Object.keys(bare.smooth).length === 0 && Object.keys(bare.dig).length === 0);
  ok("undefined conf stores as null (JSON-safe)", "conf" in bare);
}

// 10. localStorage round-trip: what saveLocal writes, parseStoredValue reads back.
{
  const p = buildStatePayload({ deck: V2.deck, conf: null, lands: { Mountain: 20 } });
  assert.deepStrictEqual(parseStoredValue(JSON.stringify(p)), p);
  ok("stored JSON payload round-trips through parseStoredValue", true);
}

// 11. Backward compat + junk: the key used to hold bare deck text.
{
  const legacy = parseStoredValue("4 Lightning Strike\n20 Mountain");
  assert.deepStrictEqual(legacy, { v: 1, deck: "4 Lightning Strike\n20 Mountain" });
  ok("legacy plain deck text parses as a v1 payload", true);
  ok("empty / absent values parse to null",
    parseStoredValue(null) === null && parseStoredValue("") === null && parseStoredValue("   ") === null);
  ok("JSON without a usable deck is rejected",
    parseStoredValue("{}") === null && parseStoredValue('{"deck":""}') === null
    && parseStoredValue('{"deck":7}') === null);
  const braced = parseStoredValue("{not json");
  ok("malformed JSON falls back to plain text", braced && braced.deck === "{not json");
}

console.log(`\n${passed} share tests passed`);
