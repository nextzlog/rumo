// Compact serialisation of feedback payloads: JSON -> raw deflate (CompressionStream,
// when available) -> base64url, prefixed "rumo1z." (deflated) or "rumo1j." (plain JSON).
// decodeTrace reverses it (for reading submitted reports).
(function (root) {
  "use strict";

  function b64url(u8) {
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function unb64url(s) {
    const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    const u8 = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) u8[i] = b.charCodeAt(i);
    return u8;
  }

  async function pipe(u8, stream) {
    const out = new Response(new Blob([u8]).stream().pipeThrough(stream));
    return new Uint8Array(await out.arrayBuffer());
  }

  async function encodeTrace(obj) {
    const json = new TextEncoder().encode(JSON.stringify(obj));
    if (typeof CompressionStream === "function") {
      try { return "rumo1z." + b64url(await pipe(json, new CompressionStream("deflate-raw"))); } catch (e) { /* fall through */ }
    }
    return "rumo1j." + b64url(json);
  }

  async function decodeTrace(s) {
    s = s.trim();
    const body = unb64url(s.slice(7));
    if (s.startsWith("rumo1z.")) return JSON.parse(new TextDecoder().decode(await pipe(body, new DecompressionStream("deflate-raw"))));
    if (s.startsWith("rumo1j.")) return JSON.parse(new TextDecoder().decode(body));
    throw new Error("unknown trace format");
  }

  const api = { encodeTrace, decodeTrace };
  root.CwTraceCodec = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self);
