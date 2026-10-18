// Pure helpers of the page (no DOM): spectrum, colour map, waterfall rows,
// lane text segments and the report fields.
(function (root) {
  "use strict";

  // ------------------------------------------------------------ spectrum
  function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

  // FFT size for a sample rate: about 80 ms of audio (4096 at 48 kHz, 1024 at 8 kHz).
  function fftSizeFor(rate) { return Math.min(16384, Math.max(256, nextPow2(Math.round(rate * 0.08)))); }

  const hannCache = new Map();
  function hann(n) {
    let w = hannCache.get(n);
    if (!w) {
      w = new Float32Array(n);
      for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
      hannCache.set(n, w);
    }
    return w;
  }

  // Power spectrum in dB (n/2 bins) of x[start, start+n), Hann windowed, radix-2 FFT.
  function powerDb(x, start, n) {
    const re = new Float64Array(n), im = new Float64Array(n), w = hann(n);
    for (let i = 0; i < n; i++) { const k = start + i; re[i] = k >= 0 && k < x.length ? x[k] * w[i] : 0; }
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const a = (-2 * Math.PI) / len, wr = Math.cos(a), wi = Math.sin(a), h = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < h; k++) {
          const p = i + k, q = p + h;
          const tr = re[q] * cr - im[q] * ci, ti = re[q] * ci + im[q] * cr;
          re[q] = re[p] - tr; im[q] = im[p] - ti; re[p] += tr; im[p] += ti;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
    let ws = 0;
    for (let i = 0; i < n; i++) ws += w[i];
    const out = new Float32Array(n >> 1), norm = 2 / (ws * ws); // a sine of amplitude A reads 10 log10(A^2/2)
    for (let i = 0; i < out.length; i++) out[i] = 10 * Math.log10((re[i] * re[i] + im[i] * im[i]) * norm + 1e-20);
    return out;
  }

  // ------------------------------------------------------------ colour map
  // Perceptually ordered, dark to bright (anchors of matplotlib "inferno").
  const ANCHORS = [
    [0.0, 0, 0, 4], [0.13, 22, 11, 57], [0.25, 66, 10, 104], [0.38, 106, 23, 110], [0.5, 147, 38, 103],
    [0.63, 188, 55, 84], [0.75, 221, 81, 58], [0.88, 246, 125, 21], [0.95, 250, 175, 30], [1.0, 252, 255, 164],
  ];
  function buildLut() {
    const lut = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let k = 1;
      while (k < ANCHORS.length - 1 && ANCHORS[k][0] < t) k++;
      const a = ANCHORS[k - 1], b = ANCHORS[k], u = (t - a[0]) / (b[0] - a[0]);
      for (let c = 0; c < 3; c++) lut[i * 3 + c] = Math.round(a[c + 1] + u * (b[c + 1] - a[c + 1]));
    }
    return lut;
  }
  const LUT = buildLut();

  // ------------------------------------------------------------ waterfall rows
  function freqToFrac(f, lo, hi) { return (f - lo) / (hi - lo); }

  // Resample a dB spectrum (bins of binHz) to `width` columns spanning lo..hi Hz.
  function bandColumns(db, binHz, width, lo, hi) {
    const out = new Float32Array(width);
    for (let x = 0; x < width; x++) {
      const b = (lo + ((x + 0.5) / width) * (hi - lo)) / binHz;
      const i = Math.max(0, Math.min(db.length - 2, Math.floor(b))), u = Math.min(1, Math.max(0, b - i));
      out[x] = db[i] + u * (db[i + 1] - db[i]);
    }
    return out;
  }

  // Noise floor of a row: the 60th percentile, so that the in-band noise of a receiver
  // whose passband covers only part of the display is dark (few carriers move it).
  function noiseFloor(cols) {
    const s = Float32Array.from(cols).sort();
    return s[Math.floor(s.length * 0.6)];
  }

  // Automatic levels.  `floor` is a slow follower of the row's noise floor;
  // `colFloors` whitens the display per column with a quantile tracker (30th
  // percentile of each column, about 1 dB/s), so that the receiver's passband shape
  // disappears and weak stations outside it stay visible; a column floor never goes
  // more than 35 dB below the row floor.  The displayed range is
  // floor - 6 dB (black) .. floor + span dB (brightest).
  function makeLevels(span) {
    let floor = null, cf = null, n = 0;
    const out = { span: span || 42, colFloors: null };
    out.update = (cols) => {
      const f = noiseFloor(cols);
      if (!isFinite(f)) return floor;
      floor = floor === null ? f : floor + (f - floor) * (f > floor ? 0.02 : 0.1);
      if (!cf || cf.length !== cols.length) { cf = new Float32Array(cols.length).fill(f - 3); out.colFloors = new Float32Array(cols.length); n = 0; }
      const step = n++ < 150 ? 0.6 : 0.15, q = 0.3;
      for (let x = 0; x < cols.length; x++) {
        const v = cols[x];
        if (isFinite(v)) cf[x] += v < cf[x] ? -step * (1 - q) : step * q;
        out.colFloors[x] = Math.max(cf[x] + 3, floor - 35);
      }
      return floor;
    };
    Object.defineProperty(out, "floor", { get: () => floor });
    return out;
  }

  // RGBA pixels of one waterfall row; floor is a number or one value per column.
  function rowPixels(cols, floor, span, out) {
    const px = out || new Uint8ClampedArray(cols.length * 4);
    const k = 255 / (span + 6), per = typeof floor !== "number";
    for (let x = 0; x < cols.length; x++) {
      const lo = (per ? floor[x] : floor) - 6;
      const v = Math.max(0, Math.min(255, Math.round((cols[x] - lo) * k)));
      px[x * 4] = LUT[v * 3]; px[x * 4 + 1] = LUT[v * 3 + 1]; px[x * 4 + 2] = LUT[v * 3 + 2]; px[x * 4 + 3] = 255;
    }
    return px;
  }

  // Frequency scale ticks: every `step` Hz, labelled every `labelEvery` Hz.
  function ticks(lo, hi, step, labelEvery) {
    const out = [];
    for (let f = Math.ceil(lo / step) * step; f <= hi; f += step) out.push({ f, frac: freqToFrac(f, lo, hi), label: f % labelEvery === 0 });
    return out;
  }

  // ------------------------------------------------------------ lanes
  const patGlyphs = (p) => (p || "").replace(/\./g, "·").replace(/-/g, "–");

  // Text segments of a lane: committed characters (class "", "doubt" or "dtok" for a
  // character of a doubtful callsign or exchange token), held
  // candidate text ("held"), tentative text ("tent"), the best guess of the open
  // character ("guess") and its dot/dash pattern ("pat").  Consecutive characters
  // of the same class are merged.  maxChars bounds the committed history shown.
  function laneSegments(t, maxChars) {
    const segs = [];
    const push = (text, cls, title) => {
      if (!text) return;
      const last = segs[segs.length - 1];
      if (last && last.cls === cls && last.title === title) last.text += text;
      else segs.push(title ? { text, cls, title } : { text, cls });
    };
    for (const c of t.committed.slice(-(maxChars || 240))) {
      if (c.d && c.ch !== " ") push(c.ch, "doubt", charTitle(c));
      else if (c.tok) push(c.ch, "dtok", TOKEN_REASON[c.tok] || "要確認");
      else push(c.ch, "");
    }
    if (t.held) push(t.held, "held");
    if (t.tent && t.alive) {
      push(t.tent.text, "tent");
      if (t.tent.pattern) { push(t.tent.guess || "?", "guess"); push(patGlyphs(t.tent.pattern), "pat"); }
    }
    return segs;
  }

  const TOKEN_REASON = {
    "doubtful-character": "不確かな文字を含む語",
    invalid: "コールサインや交換の書式に合わない",
    "run-together": "二つの語がつながっている可能性",
    unknown: "未知の語",
    truncated: "先頭の文字が欠けている可能性",
    partial: "先に読んだコールサインの一部",
  };

  function charTitle(c) {
    if (c.p === undefined || c.p === null) return "不確か";
    const alts = (c.alts || []).map((a) => `${a.ch} ${(100 * a.p).toFixed(0)}%`).join(", ");
    return `不確か: ${c.ch} ${(100 * c.p).toFixed(0)}%` + (alts ? `, ${alts}` : "");
  }

  // Plain decoded text of a track (committed + held + tentative), for the report.
  function decodedText(t, maxChars) {
    let s = t.committed.slice(-(maxChars || 400)).map((c) => c.ch).join("");
    if (t.held) s += t.held;
    if (t.tent && t.alive) s += (t.tent.text || "") + (t.tent.pattern ? t.tent.guess || "?" : "");
    return s.replace(/\s+/g, " ").trim();
  }

  // Order of the lanes: by frequency.
  function sortTracks(list) { return list.slice().sort((a, b) => a.freq - b.freq || a.id - b.id); }

  // ------------------------------------------------------------ report
  // The "decoded" form field: text, "---", metadata lines, "trace: ...".
  function decodedField(o) {
    const lines = [o.decoded || "", "---", `version: ${o.version}`, `freq: ${Math.round(o.freq)} Hz`];
    if (o.wpm !== null && o.wpm !== undefined) lines.push(`WPM: ${Math.round(o.wpm)}`);
    if (o.snr !== null && o.snr !== undefined) lines.push(`SNR: ${Math.round(o.snr)} dB`);
    if (o.extra) lines.push(o.extra);
    lines.push(`trace: ${o.trace || "(none)"}`);
    return lines.join("\n");
  }

  // Pre-filled form URL, or "" when the form is not configured.
  function formUrl(cfg, correct, decoded) {
    if (!cfg || !cfg.formUrl) return "";
    const q = new URLSearchParams({ usp: "pp_url" });
    const E = cfg.entries || {};
    if (E.correct) q.set(E.correct, correct || "");
    if (E.decoded) q.set(E.decoded, decoded || "");
    return `${cfg.formUrl}?${q}`;
  }

  const api = {
    fftSizeFor, powerDb, LUT, freqToFrac, bandColumns, noiseFloor, makeLevels, rowPixels, ticks,
    patGlyphs, laneSegments, decodedText, sortTracks, decodedField, formUrl,
  };
  root.CwView = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self);
