// Scrolling waterfall of the CW band (newest row on top), frequency scale and
// station markers.  Rows come from an AnalyserNode (microphone), from the page's
// own FFT of an opened recording, or from a decoder that exposes its spectrum.
(function (root) {
  "use strict";
  const V = root.CwView;

  class Waterfall {
    constructor({ box, canvas, markers, scale, lo, hi }) {
      this.box = box; this.canvas = canvas; this.markersEl = markers; this.scaleEl = scale;
      this.lo = lo; this.hi = hi;
      this.ctx = canvas.getContext("2d", { alpha: false });
      this.levels = V.makeLevels(36);
      this.row = null;
      this.markerEls = new Map();
      this.buildScale();
      this.resize();
      if (root.ResizeObserver) new ResizeObserver(() => this.resize()).observe(box);
      else root.addEventListener("resize", () => this.resize());
    }

    // Internal resolution: device pixels across, one row per CSS pixel down.
    resize() {
      const dpr = root.devicePixelRatio || 1;
      const w = Math.max(64, Math.min(2048, Math.round(this.box.clientWidth * dpr)));
      const h = Math.max(32, Math.round(this.box.clientHeight));
      if (w === this.canvas.width && h === this.canvas.height) return;
      let old = null;
      if (this.canvas.width > 1 && this.canvas.height > 1) {
        old = document.createElement("canvas");
        old.width = this.canvas.width; old.height = this.canvas.height;
        old.getContext("2d").drawImage(this.canvas, 0, 0);
      }
      this.canvas.width = w; this.canvas.height = h;
      this.ctx.fillStyle = "rgb(0,0,4)";
      this.ctx.fillRect(0, 0, w, h);
      if (old) this.ctx.drawImage(old, 0, 0, old.width, old.height, 0, 0, w, old.height);
      this.row = this.ctx.createImageData(w, 1);
    }

    clear() {
      this.ctx.fillStyle = "rgb(0,0,4)";
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      this.levels = V.makeLevels(36);
    }

    // db: dB power per bin, binHz: bin spacing.
    addRow(db, binHz) {
      const w = this.canvas.width, h = this.canvas.height;
      const cols = V.bandColumns(db, binHz, w, this.lo, this.hi);
      const floor = this.levels.update(cols);
      if (floor === null) return;
      V.rowPixels(cols, this.levels.colFloors || floor, this.levels.span, this.row.data);
      this.ctx.drawImage(this.canvas, 0, 0, w, h - 1, 0, 1, w, h - 1);
      this.ctx.putImageData(this.row, 0, 0);
    }

    buildScale() {
      const frag = document.createDocumentFragment();
      for (const t of V.ticks(this.lo, this.hi, 50, 100)) {
        const s = document.createElement("span");
        s.className = "tick" + (t.label ? " labelled" : "") + (t.f % 200 === 0 ? " major" : "");
        s.style.left = (100 * t.frac).toFixed(3) + "%";
        if (t.label) s.textContent = String(t.f);
        frag.appendChild(s);
      }
      this.scaleEl.replaceChildren(frag);
    }

    // stations: [{id, freq, candidate}] (live tracks only); selected: id or null.
    setStations(stations, selected) {
      const seen = new Set();
      for (const s of stations) {
        const frac = V.freqToFrac(s.freq, this.lo, this.hi);
        if (frac < 0 || frac > 1) continue;
        seen.add(s.id);
        let m = this.markerEls.get(s.id);
        if (!m) {
          m = document.createElement("button");
          m.type = "button"; m.tabIndex = -1; m.className = "marker"; m.dataset.id = s.id;
          m.appendChild(document.createElement("span")).className = "flag";
          this.markersEl.appendChild(m);
          this.markerEls.set(s.id, m);
        }
        m.style.left = (100 * frac).toFixed(3) + "%";
        m.classList.toggle("cand", !!s.candidate);
        m.classList.toggle("sel", s.id === selected);
        m.firstChild.textContent = String(Math.round(s.freq));
        m.setAttribute("aria-label", `${Math.round(s.freq)} Hz${s.candidate ? " (candidate)" : ""}`);
      }
      for (const [id, m] of this.markerEls) if (!seen.has(id)) { m.remove(); this.markerEls.delete(id); }
    }
  }

  root.CwWaterfall = Waterfall;
})(typeof globalThis !== "undefined" ? globalThis : self);
