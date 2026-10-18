// Minimal WAV reader (PCM 8/16/24/32-bit integer and 32/64-bit float, any channel count -> mono)
// and 16-bit mono WAV writer.  Classic script for the page and the worker; CommonJS for Node.
(function (root) {
  "use strict";

  function readWav(buf) {
    const u8 = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const tag = (p) => String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
    if (u8.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV file");
    let fmt = null, p = 12;
    while (p + 8 <= u8.length) {
      const id = tag(p), n = dv.getUint32(p + 4, true), body = p + 8;
      if (id === "fmt ") {
        fmt = { format: dv.getUint16(body, true), ch: dv.getUint16(body + 2, true), rate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
        if (fmt.format === 0xfffe && n >= 26) fmt.format = dv.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE
      } else if (id === "data") {
        if (!fmt) throw new Error("WAV: data before fmt");
        const bps = fmt.bits / 8, frames = Math.floor(Math.min(n, u8.length - body) / (bps * fmt.ch));
        const out = new Float32Array(frames);
        for (let i = 0; i < frames; i++) {
          let s = 0;
          for (let c = 0; c < fmt.ch; c++) {
            const q = body + (i * fmt.ch + c) * bps;
            if (fmt.format === 3) s += bps === 4 ? dv.getFloat32(q, true) : dv.getFloat64(q, true);
            else if (bps === 2) s += dv.getInt16(q, true) / 32768;
            else if (bps === 1) s += (u8[q] - 128) / 128;
            else if (bps === 3) s += (((u8[q] | (u8[q + 1] << 8) | (u8[q + 2] << 16)) << 8) >> 8) / 8388608;
            else if (bps === 4) s += dv.getInt32(q, true) / 2147483648;
            else throw new Error("WAV: unsupported sample size");
          }
          out[i] = s / fmt.ch;
        }
        return { samples: out, rate: fmt.rate };
      }
      p = body + n + (n & 1);
    }
    throw new Error("WAV: no data chunk");
  }

  // Windowed-sinc resampler (anti-aliasing low-pass at 0.45 * min(rates)).
  function resample(x, from, to) {
    if (from === to) return Float32Array.from(x);
    const ratio = from / to, n = Math.floor(x.length / ratio);
    const fc = 0.45 * Math.min(from, to) / from; // cycles per input sample
    const half = Math.ceil(16 * Math.max(1, ratio));
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i * ratio, c = Math.floor(t);
      let s = 0, w = 0;
      for (let k = c - half + 1; k <= c + half; k++) {
        if (k < 0 || k >= x.length) continue;
        const d = k - t;
        const sinc = d === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * d) / (Math.PI * d);
        const win = 0.5 + 0.5 * Math.cos(Math.PI * d / half);
        s += x[k] * sinc * win;
        w += sinc * win;
      }
      out[i] = w ? s / w : 0;
    }
    return out;
  }

  function writeWav16(x, rate) {
    const buf = new ArrayBuffer(44 + 2 * x.length), dv = new DataView(buf);
    const str = (p, s) => { for (let i = 0; i < 4; i++) dv.setUint8(p + i, s.charCodeAt(i)); };
    str(0, "RIFF"); dv.setUint32(4, 36 + 2 * x.length, true); str(8, "WAVE");
    str(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, rate, true); dv.setUint32(28, 2 * rate, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    str(36, "data"); dv.setUint32(40, 2 * x.length, true);
    for (let i = 0; i < x.length; i++) dv.setInt16(44 + 2 * i, Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), true);
    return buf;
  }

  const api = { readWav, resample, writeWav16 };
  root.CwWav = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self);
