// Thin wrapper around the rumo WASM module (plain C ABI, no runtime glue needed).
// API: load(wasmSource) -> { version, init, push, flush, snapshot, trace }.
// Works in a classic Worker (importScripts), in an AudioWorklet and in Node.js (require).
(function (root) {
  "use strict";

  function utf8(bytes) {
    if (typeof TextDecoder === "function") return new TextDecoder().decode(bytes);
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); // ASCII output
    return s;
  }

  async function instantiate(src) {
    if (src instanceof ArrayBuffer || ArrayBuffer.isView(src)) return (await WebAssembly.instantiate(src, {})).instance;
    if (WebAssembly.instantiateStreaming) {
      try { return (await WebAssembly.instantiateStreaming(fetch(src), {})).instance; } catch (e) { /* wrong MIME type */ }
    }
    const buf = await (await fetch(src)).arrayBuffer();
    return (await WebAssembly.instantiate(buf, {})).instance;
  }

  async function load(wasmSource) {
    const x = (await instantiate(wasmSource)).exports;
    const text = (n) => utf8(new Uint8Array(x.memory.buffer, x.rumo_output(), n));
    const json = (n) => JSON.parse(text(n));
    return {
      version: text(x.rumo_version()),
      init(sampleRate) { x.rumo_init(sampleRate | 0); },
      // samples: Float32Array; returns an array of events
      push(samples) {
        const n = samples.length;
        const p = x.rumo_input(n);
        new Float32Array(x.memory.buffer, p, n).set(samples);
        return json(x.rumo_push(n));
      },
      flush() { return json(x.rumo_flush()); },
      snapshot() { return json(x.rumo_snapshot()); },
      trace(trackIds, seconds) {
        const ids = trackIds || [];
        const p = x.rumo_ids(ids.length);
        new Uint32Array(x.memory.buffer, p, Math.max(ids.length, 1)).set(ids.length ? ids : [0]);
        return json(x.rumo_trace(ids.length, +seconds || 60));
      },
    };
  }

  root.CwDecoderAPI = { load };
  if (typeof module === "object" && module.exports) module.exports = { load };
})(typeof globalThis !== "undefined" ? globalThis : self);
