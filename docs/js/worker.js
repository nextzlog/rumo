// Decoder worker: owns the WASM decoder, receives audio from the AudioWorklet
// through a MessagePort (or whole recordings from the page), and posts events
// and snapshots to the page.  Running the decoder here keeps it off the audio thread.
// Decoding results do not depend on how the audio is chunked.
"use strict";
importScripts("decoder-api.js", "wav.js");

let dec = null;
let rate = 0;
let queue = [];          // pending Float32Array chunks (live audio)
let queued = 0;          // samples in queue
let busy = false;
let processed = 0;       // samples decoded since init
let workSec = 0;         // CPU seconds spent decoding
let skipped = 0;         // seconds dropped because the decoder fell behind
let maxLagSec = 20;
let lastSnap = 0;
let ring = null, ringPos = 0, ringFill = 0, ringOn = false;
let mode = "idle";       // "live" | "file" | "idle"

const ready = CwDecoderAPI.load("../rumo.wasm").then((d) => {
  dec = d;
  postMessage({ type: "ready", version: d.version });
}).catch((e) => postMessage({ type: "error", message: "解読機を読み込めませんでした: " + e }));

function reset(r) {
  rate = r;
  dec.init(r);
  queue = []; queued = 0; processed = 0; workSec = 0; skipped = 0;
  ring = null; ringPos = 0; ringFill = 0;
  if (ringOn) ring = new Float32Array(30 * r);
}

function toRing(x) {
  if (!ring) return;
  for (let i = 0; i < x.length; i++) {
    ring[ringPos] = x[i];
    ringPos = (ringPos + 1) % ring.length;
  }
  ringFill = Math.min(ring.length, ringFill + x.length);
}

function lastAudio() {
  if (!ring) return new Float32Array(0);
  const out = new Float32Array(ringFill);
  const start = (ringPos - ringFill + ring.length) % ring.length;
  for (let i = 0; i < ringFill; i++) out[i] = ring[(start + i) % ring.length];
  return out;
}

function decode(x) {
  const t0 = performance.now();
  const ev = dec.push(x);
  workSec += (performance.now() - t0) / 1000;
  processed += x.length;
  if (ev.length) postMessage({ type: "events", events: ev });
}

function status(extra) {
  const audioSec = processed / rate;
  postMessage(Object.assign({
    type: "status", mode, audioSec, backlogSec: queued / rate, skippedSec: skipped,
    speed: workSec > 0 ? audioSec / workSec : 0,
  }, extra || {}));
}

function maybeSnapshot(force) {
  const now = performance.now();
  if (!force && now - lastSnap < 250) return;
  lastSnap = now;
  postMessage({ type: "snapshot", tracks: dec.snapshot(), sample: processed });
  status();
}

// process queued live audio in slices of at most ~40 ms so that messages stay responsive
function pump() {
  if (busy) return;
  busy = true;
  const t0 = performance.now();
  while (queue.length && performance.now() - t0 < 40) {
    const x = queue.shift();
    queued -= x.length;
    decode(x);
  }
  // overload protection: if the decoder falls far behind real time, drop the oldest audio
  if (queued / rate > maxLagSec) {
    while (queued / rate > maxLagSec / 2 && queue.length) {
      const x = queue.shift();
      queued -= x.length;
      skipped += x.length / rate;
    }
  }
  maybeSnapshot(false);
  busy = false;
  if (queue.length) setTimeout(pump, 0);
}

function onAudio(x) {
  if (mode !== "live" || !dec) return;
  toRing(x);
  queue.push(x);
  queued += x.length;
  if (!busy) setTimeout(pump, 0);
}

async function decodeFile(samples, r) {
  mode = "file";
  reset(r);
  // peak normalised to 0.5, one second of silence appended so the tail can commit
  let pk = 0;
  for (let i = 0; i < samples.length; i++) pk = Math.max(pk, Math.abs(samples[i]));
  const x = new Float32Array(samples.length + r);
  for (let i = 0; i < samples.length; i++) x[i] = samples[i] * (0.5 / Math.max(pk, 1e-9));
  toRing(x.subarray(0, samples.length));
  const step = 4096;
  for (let i = 0; i < x.length; i += step) {
    decode(x.subarray(i, Math.min(i + step, x.length)));
    if ((i / step) % 16 === 0) {
      maybeSnapshot(true);
      postMessage({ type: "progress", done: i / x.length });
      await new Promise((res) => setTimeout(res, 0));
      if (mode !== "file") return; // cancelled
    }
  }
  maybeSnapshot(true);
  const fl = dec.flush();
  if (fl.length) postMessage({ type: "events", events: fl });
  status({ finished: true });
  mode = "idle";
}

onmessage = async (m) => {
  const msg = m.data;
  await ready;
  if (!dec) return;
  switch (msg.cmd) {
    case "live":
      mode = "live";
      if (msg.maxLagSec) maxLagSec = msg.maxLagSec;
      reset(msg.rate);
      msg.port.onmessage = (e) => onAudio(e.data);
      status();
      break;
    case "stop":
      if (mode === "live") {
        while (queue.length) { const x = queue.shift(); queued -= x.length; decode(x); }
        maybeSnapshot(true);
      }
      mode = "idle";
      status();
      break;
    case "file":
      decodeFile(msg.samples, msg.rate);
      break;
    case "ring":
      ringOn = !!msg.on;
      if (ringOn && !ring && rate) ring = new Float32Array(30 * rate);
      if (!ringOn) { ring = null; ringFill = 0; ringPos = 0; }
      break;
    case "sync": // reports progress (for automated checks)
      postMessage({ type: "sync", id: msg.id, audioSec: processed / rate, backlogSec: queued / rate });
      break;
    case "trace":
      postMessage({ type: "trace", id: msg.id, trace: dec.trace(msg.tracks, msg.seconds || 60) });
      break;
    case "wav": {
      const x = CwWav.resample(lastAudio(), rate, 8000);
      let pk = 0;
      for (let i = 0; i < x.length; i++) pk = Math.max(pk, Math.abs(x[i]));
      if (pk > 1) for (let i = 0; i < x.length; i++) x[i] /= pk;
      const buf = CwWav.writeWav16(x, 8000);
      postMessage({ type: "wav", id: msg.id, wav: buf, seconds: x.length / 8000 }, [buf]);
      break;
    }
  }
};
