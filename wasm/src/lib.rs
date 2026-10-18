//! WebAssembly wrapper of rumo with a plain C ABI (no wasm-bindgen).
//! The JavaScript glue (decoder-api.js) copies samples into the input buffer, calls an
//! export, and reads the JSON result from the output buffer.
//! Exports: rumo_init(rate), rumo_input(n) -> *f32, rumo_push(n) -> len, rumo_flush() -> len,
//! rumo_snapshot() -> len, rumo_ids(n) -> *u32, rumo_trace(n_ids, seconds) -> len,
//! rumo_version() -> len, rumo_output() -> *u8.

use rumo::{Decoder, Event};
mod json;
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::fmt::Write;

const VERSION: &str = "rumo-0.1.0";

#[derive(Default)]
struct TraceChar {
    frame: i64,
    ch: char,
    p: i64,
    d: bool,
    alts: String,
}

#[derive(Default)]
struct TrackTrace {
    freq: f64,
    last: i64,
    elements: Vec<(i64, i64)>,
    timing: Vec<[f64; 6]>,
    chars: Vec<TraceChar>,
}

struct State {
    dec: Decoder,
    rate: u32,
    input: Vec<f32>,
    ids: Vec<u32>,
    out: String,
    tr: BTreeMap<u32, TrackTrace>,
    last_tm: i64,
}

thread_local! {
    static ST: RefCell<Option<State>> = const { RefCell::new(None) };
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn with<R>(f: impl FnOnce(&mut State) -> R) -> R {
    ST.with(|s| {
        let mut s = s.borrow_mut();
        if s.is_none() {
            *s = Some(State::new(48000));
        }
        f(s.as_mut().unwrap())
    })
}

fn r1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}
fn r2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

impl State {
    fn new(rate: u32) -> State {
        let mut dec = Decoder::new(rate);
        dec.record_elements(true);
        State {
            dec,
            rate,
            input: Vec::new(),
            ids: Vec::new(),
            out: String::new(),
            tr: BTreeMap::new(),
            last_tm: 0,
        }
    }

    fn observe(&mut self, evs: &[Event]) {
        let frame = self.dec.frame_count();
        let fs = self.dec.frame_seconds();
        for (id, fr, el) in self.dec.take_elements() {
            let ms = (el.d * 1000.0).round() as i64;
            self.tr
                .entry(id)
                .or_default()
                .elements
                .push((fr, if el.mark { ms } else { -ms }));
        }
        for e in evs {
            if let Event::Commit { track, chars, .. } = e {
                let t = self.tr.entry(*track).or_default();
                for c in chars {
                    if c.ch == ' ' {
                        continue;
                    }
                    let alts: Vec<String> = c
                        .alts
                        .iter()
                        .map(|a| format!("{}:{}", a.ch, (a.p * 1000.0).round() as i64))
                        .collect();
                    t.chars.push(TraceChar {
                        frame,
                        ch: c.ch,
                        p: (c.p * 1000.0).round() as i64,
                        d: c.doubtful,
                        alts: alts.join(","),
                    });
                }
            }
        }
        let snap = self.dec.snapshot();
        let tm = frame / 100 != self.last_tm / 100;
        for s in &snap {
            let t = self.tr.entry(s.track).or_default();
            t.freq = s.freq;
            t.last = frame;
            if tm {
                t.timing.push([
                    (frame / 100 * 100) as f64,
                    s.wpm,
                    s.ratio,
                    s.bias,
                    s.snr,
                    s.level,
                ]);
            }
        }
        self.last_tm = frame;
        // drop data older than 90 s
        let keep = frame - (90.0 / fs) as i64;
        let live: Vec<u32> = snap.iter().map(|s| s.track).collect();
        self.tr.retain(|id, t| t.last >= keep || live.contains(id));
        for t in self.tr.values_mut() {
            t.elements.retain(|e| e.0 >= keep);
            t.timing.retain(|e| e[0] as i64 >= keep);
            t.chars.retain(|c| c.frame >= keep);
        }
    }

    fn trace(&self, ids: &[u32], seconds: f64) -> String {
        let fs = self.dec.frame_seconds();
        let frame = self.dec.frame_count();
        let from = frame - (seconds / fs) as i64;
        let snap = self.dec.snapshot();
        let mut s = String::new();
        let _ = write!(
            s,
            "{{\"fmt\":\"rumo-trace-1\",\"dec\":\"{VERSION}\",\"rate\":{},\"fs\":{fs},\"now\":{frame},\"tr\":[",
            self.rate
        );
        let mut first = true;
        for (id, t) in &self.tr {
            if (!ids.is_empty() && !ids.contains(id)) || t.last < from {
                continue;
            }
            let live = snap.iter().find(|x| x.track == *id);
            let chars: Vec<&TraceChar> = t.chars.iter().filter(|c| c.frame >= from).collect();
            let held: String = live
                .map(|x| x.held.iter().map(|c| c.ch).collect())
                .unwrap_or_default();
            if ids.is_empty() && chars.is_empty() && held.is_empty() {
                continue;
            }
            if !first {
                s.push(',');
            }
            first = false;
            let _ = write!(
                s,
                "{{\"id\":{id},\"hz\":{},\"live\":{},\"el\":[",
                r1(t.freq),
                live.is_some()
            );
            let els: Vec<String> = t
                .elements
                .iter()
                .filter(|e| e.0 >= from)
                .map(|e| format!("[{},{}]", e.0, e.1))
                .collect();
            s.push_str(&els.join(","));
            s.push_str("],\"tm\":[");
            let tms: Vec<String> = t
                .timing
                .iter()
                .filter(|e| e[0] as i64 >= from)
                .map(|e| {
                    format!(
                        "[{},{},{},{},{},{}]",
                        e[0],
                        r1(e[1]),
                        r2(e[2]),
                        r2(e[3]),
                        r1(e[4]),
                        r1(e[5])
                    )
                })
                .collect();
            s.push_str(&tms.join(","));
            s.push_str("],\"ch\":[");
            let chs: Vec<String> = chars
                .iter()
                .map(|c| {
                    let mut o = format!("{{\"f\":{},\"c\":\"{}\",\"p\":{}", c.frame, c.ch, c.p);
                    if c.d {
                        o.push_str(",\"d\":true");
                    }
                    if !c.alts.is_empty() {
                        let _ = write!(o, ",\"a\":\"{}\"", c.alts);
                    }
                    o.push('}');
                    o
                })
                .collect();
            s.push_str(&chs.join(","));
            s.push(']');
            if let Some(x) = live {
                if !x.guesses.is_empty() {
                    let g = json::tracks_json(std::slice::from_ref(x));
                    if let Some(p) = g.find("\"guesses\":") {
                        s.push_str(",\"tg\":");
                        s.push_str(&g[p + 10..g.len() - 2]);
                    }
                }
                if !held.is_empty() {
                    let _ = write!(s, ",\"held\":\"{held}\"");
                }
            }
            s.push('}');
        }
        s.push_str("]}");
        s
    }
}

fn emit(s: String) -> usize {
    OUT.with(|o| {
        let mut o = o.borrow_mut();
        o.clear();
        o.extend_from_slice(s.as_bytes());
        o.len()
    })
}

#[no_mangle]
pub extern "C" fn rumo_init(rate: u32) {
    ST.with(|s| *s.borrow_mut() = Some(State::new(rate)));
}

#[no_mangle]
pub extern "C" fn rumo_input(n: usize) -> *mut f32 {
    with(|s| {
        if s.input.len() < n {
            s.input.resize(n, 0.0);
        }
        s.input.as_mut_ptr()
    })
}

#[no_mangle]
pub extern "C" fn rumo_push(n: usize) -> usize {
    let js = with(|s| {
        let x = std::mem::take(&mut s.input);
        let evs = s.dec.push(&x[..n.min(x.len())]);
        s.input = x;
        s.observe(&evs);
        s.out = json::events_json(&evs);
        std::mem::take(&mut s.out)
    });
    emit(js)
}

#[no_mangle]
pub extern "C" fn rumo_flush() -> usize {
    let js = with(|s| {
        let evs = s.dec.flush();
        s.observe(&evs);
        json::events_json(&evs)
    });
    emit(js)
}

#[no_mangle]
pub extern "C" fn rumo_snapshot() -> usize {
    let js = with(|s| json::tracks_json(&s.dec.snapshot()));
    emit(js)
}

#[no_mangle]
pub extern "C" fn rumo_ids(n: usize) -> *mut u32 {
    with(|s| {
        s.ids.resize(n.max(1), 0);
        s.ids.as_mut_ptr()
    })
}

#[no_mangle]
pub extern "C" fn rumo_trace(n_ids: usize, seconds: f64) -> usize {
    let js = with(|s| s.trace(&s.ids[..n_ids.min(s.ids.len())], seconds));
    emit(js)
}

#[no_mangle]
pub extern "C" fn rumo_version() -> usize {
    emit(VERSION.to_string())
}

#[no_mangle]
pub extern "C" fn rumo_output() -> *const u8 {
    OUT.with(|o| o.borrow().as_ptr())
}
