// Page logic: audio input, waterfall, station lanes, correction reports.
// The decoder (rumo.wasm) runs in js/worker.js behind js/decoder-api.js.
"use strict";
(function () {
  const APP_VERSION = "rumo-web 0.2.0";
  const cfg = window.RUMO_CONFIG || {};
  const V = window.CwView;
  const BAND_LO = cfg.bandLo || 250, BAND_HI = cfg.bandHi || 1300;
  const ROW_SEC = 0.04; // waterfall: one row per 40 ms of audio
  const $ = (id) => document.getElementById(id);
  const el = {
    theme: $("theme"), device: $("device"), start: $("start"), stop: $("stop"), open: $("open"), file: $("file"),
    showCand: $("showCand"), status: $("status"), wf: $("wf"), wfCanvas: $("wfCanvas"), markers: $("markers"),
    scale: $("scale"), lanes: $("lanes"), empty: $("empty"), ringOn: $("ringOn"), saveWav: $("saveWav"),
    versions: $("versions"), report: $("report"), repFreq: $("repFreq"), repDecoded: $("repDecoded"),
    repCorrect: $("repCorrect"), withTrace: $("withTrace"), repMsg: $("repMsg"), repCopy: $("repCopy"),
    repSend: $("repSend"),
  };

  const store = {
    get(k, d) { try { const v = localStorage.getItem("rumo." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("rumo." + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };

  // ---------------------------------------------------------------- theme
  const darkMq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const effectiveTheme = () => document.documentElement.dataset.theme || (darkMq && !darkMq.matches ? "light" : "dark");
  function showThemeButton() {
    const next = effectiveTheme() === "dark" ? "ライト" : "ダーク";
    el.theme.textContent = next;
    el.theme.setAttribute("aria-label", `${next}表示に切り替える`);
  }
  el.theme.addEventListener("click", () => {
    const t = effectiveTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = t;
    store.set("theme", t);
    showThemeButton();
  });
  if (darkMq && darkMq.addEventListener) darkMq.addEventListener("change", showThemeButton);
  showThemeButton();

  // ---------------------------------------------------------------- state
  let decoderVersion = "?";
  let rate = 48000;
  let source = "none";        // "mic" | "file"
  let ctx = null, stream = null, node = null, analyser = null, anaBuf = null;
  const tracks = new Map();   // id -> track model
  let selectedId = null;
  let dirty = false;
  let lastStatus = {};
  let reqId = 0;
  const pending = new Map();
  let decoderSpectrum = false; // true once the decoder posts its own spectrum rows

  const wf = new window.CwWaterfall({ box: el.wf, canvas: el.wfCanvas, markers: el.markers, scale: el.scale, lo: BAND_LO, hi: BAND_HI });

  const worker = new Worker("js/worker.js");
  worker.onmessage = (m) => onWorker(m.data);
  worker.onerror = (e) => setStatus("解読機のエラー: " + (e.message || e), true);

  function setStatus(s, warn) {
    el.status.textContent = s;
    el.status.classList.toggle("warn", !!warn);
  }

  function request(msg) {
    const id = ++reqId;
    return new Promise((resolve) => { pending.set(id, resolve); worker.postMessage(Object.assign({ id }, msg)); });
  }

  function onWorker(msg) {
    switch (msg.type) {
      case "ready":
        decoderVersion = msg.version;
        el.versions.textContent = `${APP_VERSION} · decoder ${decoderVersion}`;
        el.start.disabled = false; el.open.disabled = false;
        setStatus("準備ができました。「開始」でマイクから聞き取るか、WAV録音を開いてください。");
        break;
      case "error":
        setStatus(msg.message, true);
        break;
      case "events":
        for (const e of msg.events) applyEvent(e);
        dirty = true;
        break;
      case "snapshot":
        applySnapshot(msg.tracks);
        if (source === "file") file.decoded = msg.sample;
        dirty = true;
        break;
      case "spectrum": // optional: a decoder that exposes its spectrum ({db, binHz})
        decoderSpectrum = true;
        wf.addRow(msg.db, msg.binHz);
        break;
      case "status":
        lastStatus = msg;
        showStatus(msg);
        break;
      case "progress":
        if (source === "file") setStatus(`${file.name} を解読中… ${Math.round(100 * msg.done)}%`);
        break;
      case "trace":
      case "wav": {
        const r = pending.get(msg.id);
        if (r) { pending.delete(msg.id); r(msg); }
        break;
      }
    }
  }

  function showStatus(s) {
    if (s.mode === "live") {
      const behind = s.backlogSec > 1;
      setStatus(`聞き取り中 · ${fmtTime(s.audioSec)}` +
        (behind ? ` · 解読が ${s.backlogSec.toFixed(1)} 秒遅れています` : "") +
        (s.skippedSec > 0 ? ` · ${s.skippedSec.toFixed(0)} 秒分を飛ばしました(混みすぎて解読が追いつきません)` : ""), behind || s.skippedSec > 0);
    } else if (s.finished) {
      file.decoded = Infinity;
      setStatus(`${file.name}: ${fmtTime(s.audioSec)} を解読しました(実時間の ${s.speed.toFixed(1)} 倍速)。`);
      el.start.disabled = false; el.open.disabled = false;
    }
  }

  function fmtTime(s) {
    s = Math.floor(s || 0);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  // ---------------------------------------------------------------- track model
  function track(id) {
    let t = tracks.get(id);
    if (!t) {
      t = { id, freq: 0, snr: null, wpm: null, candidate: true, alive: true, keyOn: false,
        committed: [], held: "", tent: null, endedAt: 0, rev: 0 };
      tracks.set(id, t);
    }
    return t;
  }

  function applyEvent(e) {
    switch (e.type) {
      case "TrackBorn": { const t = track(e.track); t.freq = e.freq; t.candidate = !!e.candidate; t.alive = true; t.rev++; break; }
      case "TrackConfirmed": { const t = track(e.track); t.candidate = false; t.rev++; break; }
      case "Commit": {
        const t = track(e.track);
        if (e.freq) t.freq = e.freq;
        for (const c of e.chars || []) t.committed.push({ ch: c.ch, p: c.p, d: c.doubtful, alts: c.alts });
        if (t.committed.length > 4000) t.committed.splice(0, t.committed.length - 4000);
        t.held = ""; t.rev++;
        break;
      }
      case "Tentative": {
        const t = track(e.track);
        t.held = e.held || "";
        t.tent = { text: e.text || "", pattern: e.pattern || "", guess: e.guess || "", p: e.p, alts: e.alts || [] };
        t.rev++;
        break;
      }
      case "TrackLost": {
        const t = tracks.get(e.track);
        if (!t) break;
        if (t.candidate || t.committed.length === 0) { tracks.delete(e.track); if (selectedId === e.track) selectedId = null; break; }
        t.alive = false; t.tent = null; t.held = ""; t.keyOn = false; t.endedAt = Date.now(); t.rev++;
        break;
      }
    }
  }

  function applySnapshot(list) {
    for (const s of list || []) {
      const t = tracks.get(s.track);
      if (!t) continue;
      if (Math.round(t.wpm || 0) !== Math.round(s.wpm || 0) || Math.round(t.freq) !== Math.round(s.freq) || t.candidate !== s.candidate) t.rev++;
      t.freq = s.freq; t.snr = s.snr; t.wpm = s.wpm; t.keyOn = s.keyOn; t.candidate = s.candidate;
    }
    // keep at most 30 ended stations
    const ended = [...tracks.values()].filter((t) => !t.alive).sort((a, b) => a.endedAt - b.endedAt);
    while (ended.length > 30) { const t = ended.shift(); tracks.delete(t.id); if (selectedId === t.id) selectedId = null; }
  }

  // ---------------------------------------------------------------- lanes
  const laneEls = new Map(); // id -> {li, f, txt, w, rev, sel}

  function makeLane(t) {
    const li = document.createElement("li");
    li.className = "lane"; li.dataset.id = t.id; li.tabIndex = 0;
    const f = document.createElement("span"); f.className = "lf";
    const box = document.createElement("span"); box.className = "lt";
    const txt = document.createElement("span"); txt.className = "text";
    box.appendChild(txt);
    const w = document.createElement("span"); w.className = "lw";
    const btn = document.createElement("button"); btn.type = "button"; btn.className = "lr quiet"; btn.textContent = "訂正";
    li.append(f, box, w, btn);
    return { li, f, box, txt, w, btn, rev: -1, sel: null };
  }

  function updateLane(L, t) {
    const sel = t.id === selectedId;
    if (L.rev === t.rev && L.sel === sel) return;
    L.rev = t.rev; L.sel = sel;
    L.li.className = "lane" + (t.candidate ? " cand" : "") + (t.alive ? "" : " ended") + (sel ? " sel" : "");
    if (sel) L.li.setAttribute("aria-current", "true"); else L.li.removeAttribute("aria-current");
    const hz = `${Math.round(t.freq)} Hz`;
    L.f.textContent = hz;
    L.w.textContent = t.wpm ? `${Math.round(t.wpm)} WPM` : "";
    L.btn.setAttribute("aria-label", `${hz} の解読結果を訂正する`);
    const frag = document.createDocumentFragment();
    for (const s of V.laneSegments(t, sel ? 2000 : 240)) {
      if (!s.cls) { frag.appendChild(document.createTextNode(s.text)); continue; }
      const sp = document.createElement("span");
      sp.className = s.cls; sp.textContent = s.text;
      if (s.title) sp.title = s.title;
      frag.appendChild(sp);
    }
    L.txt.replaceChildren(frag);
    L.box.classList.toggle("over", !sel && L.box.scrollWidth > L.box.clientWidth + 1);
    L.li.setAttribute("aria-label", `${hz}${t.candidate ? "(候補)" : ""}${t.alive ? "" : "(終了)"}: ${V.decodedText(t, 80)}`);
    if (sel) L.box.scrollTop = L.box.scrollHeight; // selected lane wraps; keep the newest text in view
  }

  function render() {
    if (!dirty) return;
    dirty = false;
    const showCand = el.showCand.checked;
    const list = V.sortTracks([...tracks.values()].filter((t) => showCand || !t.candidate));
    // lanes, keyed by track id so that focus and scroll positions survive updates
    let prev = null;
    const seen = new Set();
    for (const t of list) {
      seen.add(t.id);
      let L = laneEls.get(t.id);
      if (!L) { L = makeLane(t); laneEls.set(t.id, L); }
      const want = prev ? prev.nextSibling : el.lanes.firstChild;
      if (want !== L.li) el.lanes.insertBefore(L.li, want);
      updateLane(L, t);
      prev = L.li;
    }
    for (const [id, L] of laneEls) if (!seen.has(id)) { L.li.remove(); laneEls.delete(id); }
    el.empty.hidden = list.length > 0;
    wf.setStations(list.filter((t) => t.alive), selectedId);
  }

  function select(id, scroll) {
    selectedId = selectedId === id && !scroll ? null : id;
    dirty = true;
    render();
    const L = laneEls.get(id);
    if (L && scroll) L.li.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  el.lanes.addEventListener("click", (e) => {
    const li = e.target.closest(".lane");
    if (!li) return;
    const id = +li.dataset.id;
    if (e.target.closest(".lr")) { selectedId = id; dirty = true; openReport(id); return; }
    select(id, false);
  });
  el.lanes.addEventListener("keydown", (e) => {
    const li = e.target.closest(".lane");
    if (!li || e.target !== li) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(+li.dataset.id, false); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = e.key === "ArrowDown" ? li.nextElementSibling : li.previousElementSibling;
      if (n) n.focus();
    }
  });
  el.markers.addEventListener("click", (e) => {
    const m = e.target.closest(".marker");
    if (!m) return;
    const id = +m.dataset.id;
    selectedId = null; // a marker click always selects
    select(id, true);
    const L = laneEls.get(id);
    if (L) L.li.focus({ preventScroll: true });
  });

  el.showCand.checked = store.get("showCand", true);
  el.showCand.addEventListener("change", () => { store.set("showCand", el.showCand.checked); dirty = true; });

  // ---------------------------------------------------------------- waterfall feed
  const file = { samples: null, name: "", rate: 0, n: 0, hop: 0, pos: 0, decoded: 0 };
  let micAcc = 0, lastT = 0;

  function feedWaterfall(now) {
    const dt = lastT ? Math.min(0.25, (now - lastT) / 1000) : 0;
    lastT = now;
    if (decoderSpectrum) return;
    if (analyser) {
      micAcc += dt;
      let k = 0;
      while (micAcc >= ROW_SEC && k++ < 4) {
        micAcc -= ROW_SEC;
        analyser.getFloatFrequencyData(anaBuf);
        wf.addRow(anaBuf, rate / analyser.fftSize);
      }
      if (micAcc > ROW_SEC) micAcc = 0;
    } else if (file.samples) {
      // follow the decoder's progress through the recording
      const limit = Math.min(file.decoded, file.samples.length);
      const rows = wf.canvas.height;
      if (limit - file.pos > rows * file.hop) file.pos = limit - rows * file.hop; // far behind: skip ahead
      let k = 0;
      while (file.pos + file.n / 2 <= limit && k++ < 6) {
        wf.addRow(V.powerDb(file.samples, file.pos - file.n / 2, file.n), file.rate / file.n);
        file.pos += file.hop;
      }
      if (file.pos + file.n / 2 > file.samples.length && limit >= file.samples.length) file.samples = null; // done
    }
  }

  (function loop(now) { feedWaterfall(now || 0); render(); requestAnimationFrame(loop); })();

  // ---------------------------------------------------------------- audio input
  async function listDevices() {
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
      const cur = el.device.value || store.get("device", "");
      el.device.replaceChildren(new Option("既定のマイク", ""));
      devs.forEach((d, i) => { if (d.deviceId && d.deviceId !== "default") el.device.add(new Option(d.label || `マイク ${i + 1}`, d.deviceId)); });
      el.device.value = [...el.device.options].some((o) => o.value === cur) ? cur : "";
    } catch (e) { /* not available */ }
  }
  if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    listDevices();
    if (navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener("devicechange", listDevices);
  }
  el.device.addEventListener("change", () => store.set("device", el.device.value));

  function resetTracks() {
    tracks.clear(); selectedId = null; dirty = true;
    for (const L of laneEls.values()) L.li.remove();
    laneEls.clear();
    wf.clear();
  }

  el.start.addEventListener("click", async () => {
    if (!navigator.mediaDevices || !window.AudioWorkletNode) {
      setStatus("このブラウザではマイク入力(getUserMedia / AudioWorklet)が使えません。https のページで開いてください。", true);
      return;
    }
    el.start.disabled = true; el.open.disabled = true;
    try {
      const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
      if (el.device.value) audio.deviceId = { exact: el.device.value };
      stream = await navigator.mediaDevices.getUserMedia({ audio });
      ctx = new AudioContext({ latencyHint: "interactive" });
      await ctx.audioWorklet.addModule("js/worklet.js");
      rate = ctx.sampleRate;
      const src = ctx.createMediaStreamSource(stream);
      node = new AudioWorkletNode(ctx, "cw-tap", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      const ch = new MessageChannel();
      node.port.postMessage({ port: ch.port1 }, [ch.port1]);
      worker.postMessage({ cmd: "live", rate, port: ch.port2, maxLagSec: cfg.maxLagSec || 20 }, [ch.port2]);
      worker.postMessage({ cmd: "ring", on: el.ringOn.checked });
      src.connect(node);
      node.connect(ctx.destination); // outputs silence; keeps the node pulled by the graph
      analyser = ctx.createAnalyser(); // waterfall only; costs the decoder nothing
      analyser.fftSize = V.fftSizeFor(rate);
      analyser.smoothingTimeConstant = 0;
      anaBuf = new Float32Array(analyser.frequencyBinCount);
      src.connect(analyser);
      await ctx.resume();
      source = "mic"; file.samples = null;
      resetTracks();
      el.stop.disabled = false;
      el.saveWav.disabled = !el.ringOn.checked;
      listDevices(); // labels become visible after permission
    } catch (e) {
      setStatus("マイクを開始できませんでした: " + (e.message || e), true);
      stopAudio();
      el.start.disabled = false; el.open.disabled = false;
    }
  });

  function stopAudio() {
    if (node) { try { node.disconnect(); } catch (e) { /* ignore */ } node = null; }
    analyser = null;
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    if (ctx) { ctx.close(); ctx = null; }
  }

  el.stop.addEventListener("click", () => {
    stopAudio();
    worker.postMessage({ cmd: "stop" });
    el.stop.disabled = true; el.start.disabled = false; el.open.disabled = false;
    setStatus("停止しました。解読結果は画面に残っているので、このまま訂正できます。");
  });

  el.open.addEventListener("click", () => el.file.click());
  el.file.addEventListener("change", async () => {
    const f = el.file.files[0];
    if (!f) return;
    el.start.disabled = true; el.open.disabled = true;
    setStatus(`${f.name} を読み込み中…`);
    try {
      const buf = await f.arrayBuffer();
      let samples, r;
      try {
        ({ samples, rate: r } = CwWav.readWav(buf));
      } catch (e) {
        const ac = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 48000);
        const ab = await ac.decodeAudioData(buf.slice(0));
        r = ab.sampleRate;
        samples = new Float32Array(ab.length);
        for (let c = 0; c < ab.numberOfChannels; c++) { const d = ab.getChannelData(c); for (let i = 0; i < d.length; i++) samples[i] += d[i] / ab.numberOfChannels; }
      }
      rate = r; source = "file";
      resetTracks();
      const n = V.fftSizeFor(r);
      Object.assign(file, { samples: samples.slice(), name: f.name, rate: r, n, hop: Math.round(r * ROW_SEC), pos: 0, decoded: 0 });
      setStatus(`${f.name} を解読中(${(samples.length / r).toFixed(1)} 秒, ${r} Hz)…`);
      worker.postMessage({ cmd: "ring", on: el.ringOn.checked });
      worker.postMessage({ cmd: "file", samples, rate: r }, [samples.buffer]);
      el.saveWav.disabled = !el.ringOn.checked;
    } catch (e) {
      setStatus("ファイルを読み込めませんでした: " + (e.message || e), true);
      el.start.disabled = false; el.open.disabled = false;
    }
    el.file.value = "";
  });

  // ---------------------------------------------------------------- optional audio save (advanced)
  el.ringOn.checked = false; // always off at page load
  el.ringOn.addEventListener("change", () => {
    worker.postMessage({ cmd: "ring", on: el.ringOn.checked });
    el.saveWav.disabled = !el.ringOn.checked || source === "none";
  });
  el.saveWav.addEventListener("click", async () => {
    const r = await request({ cmd: "wav" });
    if (!r.seconds) { setStatus("保持している音声がありません(聞き取りの前か最中にオプションをオンにしてください)。", true); return; }
    download(new Blob([r.wav], { type: "audio/wav" }), `cw-${stamp()}-8k.wav`);
  });

  function stamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-"); }
  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ---------------------------------------------------------------- correction report
  // The trace is prepared when the dialog opens, so that "Open the form" can open
  // the window synchronously (no popup blocking).
  const rep = { id: null, decoded: "", meta: null, trace: "", ready: null };

  async function openReport(id) {
    const t = tracks.get(id);
    if (!t) return;
    rep.id = id;
    rep.decoded = V.decodedText(t, 400);
    rep.meta = { version: `${APP_VERSION}; decoder ${decoderVersion}`, freq: t.freq, wpm: t.wpm, snr: t.snr, extra: `input: ${source} ${rate} Hz` };
    rep.trace = "";
    el.repFreq.textContent = `${Math.round(t.freq)} Hz` + (t.wpm ? `, ${Math.round(t.wpm)} WPM` : "");
    el.repDecoded.textContent = rep.decoded || "(まだ何も解読されていません)";
    el.repCorrect.value = rep.decoded;
    el.repMsg.hidden = true; el.repCopy.hidden = true;
    el.repSend.hidden = !cfg.formUrl;
    if (!cfg.formUrl) { el.repMsg.hidden = false; el.repMsg.textContent = "このサイトではフォームが設定されていません。「報告をコピー」で内容をコピーし、管理者に送ってください。"; el.repCopy.hidden = false; }
    if (typeof el.report.showModal === "function") el.report.showModal(); else el.report.setAttribute("open", "");
    el.repCorrect.focus();
    el.repSend.disabled = true;
    rep.ready = (async () => {
      try {
        const r = await request({ cmd: "trace", tracks: [id], seconds: cfg.traceSeconds || 60 });
        rep.trace = await CwTraceCodec.encodeTrace(Object.assign({ app: APP_VERSION, decoded: rep.decoded }, r.trace));
      } catch (e) { rep.trace = ""; }
      el.repSend.disabled = false;
    })();
  }

  function reportFields(withTrace) {
    const correct = el.repCorrect.value.trim();
    const trace = el.withTrace.checked ? withTrace : "(not attached)";
    return { correct, decoded: V.decodedField(Object.assign({ decoded: rep.decoded, trace }, rep.meta)) };
  }

  el.repSend.addEventListener("click", () => {
    const full = reportFields(rep.trace);
    let url = V.formUrl(cfg, full.correct, full.decoded);
    if (url.length > (cfg.maxUrlLength || 7000)) {
      // too long for a link: open the form without the trace and copy the full field for pasting
      const short = reportFields("(too long for a link; pasted by the user)"); // kept in English for whoever reads the form
      url = V.formUrl(cfg, short.correct, short.decoded);
      copy(full.decoded, "解読結果と記録");
      el.repMsg.hidden = false; el.repCopy.hidden = false;
      el.repMsg.textContent = "解読の記録が長すぎてリンクに入らないため、クリップボードにコピーしました。フォームの2番目の欄の内容を貼り付けで置き換えてから送信してください。";
    }
    window.open(url, "_blank", "noopener");
  });
  el.repCopy.addEventListener("click", async () => {
    await rep.ready;
    const f = reportFields(rep.trace);
    copy(`実際に聞こえた文字:\n${f.correct}\n\n解読結果:\n${f.decoded}\n`, "報告");
  });

  async function copy(text, what) {
    try { await navigator.clipboard.writeText(text); setStatus(`${what}をクリップボードにコピーしました。`); }
    catch (e) { el.repMsg.hidden = false; el.repMsg.textContent = "コピーできませんでした。次の文字列を選択して手動でコピーしてください: " + text.slice(0, 2000); }
  }
})();
