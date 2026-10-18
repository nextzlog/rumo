//! JSON serialisation of rumo events and track states (the format the web app reads).

use rumo::{Alt, Char, Event, Guess, TrackState};
use std::fmt::Write;

fn esc(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn num(out: &mut String, x: f64) {
    if x.is_finite() {
        let _ = write!(out, "{x}");
    } else {
        out.push_str("null");
    }
}

struct Obj<'a> {
    out: &'a mut String,
    first: bool,
}

impl<'a> Obj<'a> {
    fn new(out: &'a mut String) -> Obj<'a> {
        out.push('{');
        Obj { out, first: true }
    }
    fn key(&mut self, k: &str) -> &mut String {
        if !self.first {
            self.out.push(',');
        }
        self.first = false;
        esc(self.out, k);
        self.out.push(':');
        self.out
    }
    fn str(&mut self, k: &str, v: &str) {
        let o = self.key(k);
        esc(o, v);
    }
    fn num(&mut self, k: &str, v: f64) {
        let o = self.key(k);
        num(o, v);
    }
    fn int(&mut self, k: &str, v: u64) {
        let o = self.key(k);
        let _ = write!(o, "{v}");
    }
    fn bool(&mut self, k: &str, v: bool) {
        let o = self.key(k);
        o.push_str(if v { "true" } else { "false" });
    }
    fn end(self) {
        self.out.push('}');
    }
}

fn alts_json(out: &mut String, a: &[Alt]) {
    out.push('[');
    for (i, x) in a.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        let mut o = Obj::new(out);
        o.str("ch", &x.ch.to_string());
        o.num("p", x.p);
        o.end();
    }
    out.push(']');
}

fn guesses_json(out: &mut String, a: &[Guess]) {
    out.push('[');
    for (i, g) in a.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        let mut o = Obj::new(out);
        o.str("text", &g.text);
        o.str("pattern", &g.pattern);
        o.str("char", &g.ch);
        o.num("p", g.p);
        o.end();
    }
    out.push(']');
}

fn chars_json(out: &mut String, cs: &[Char], with_alts: bool) {
    out.push('[');
    for (i, c) in cs.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        let mut o = Obj::new(out);
        o.str("ch", &c.ch.to_string());
        o.num("p", c.p);
        o.bool("doubtful", c.doubtful);
        if with_alts && !c.alts.is_empty() {
            alts_json(o.key("alts"), &c.alts);
        }
        o.end();
    }
    out.push(']');
}

/// Event type name.
pub fn kind(e: &Event) -> &'static str {
    match e {
        Event::TrackBorn { .. } => "TrackBorn",
        Event::TrackConfirmed { .. } => "TrackConfirmed",
        Event::Commit { .. } => "Commit",
        Event::Tentative { .. } => "Tentative",
        Event::Correction { .. } => "Correction",
        Event::TrackLost { .. } => "TrackLost",
    }
}

/// Appends the event as one JSON object (fields that are empty, zero or false are omitted
/// where the web app's format omits them).
pub fn write_event(e: &Event, out: &mut String) {
    let mut o = Obj::new(out);
    o.str("type", kind(e));
    match e {
        Event::TrackBorn {
            track,
            sample,
            freq,
            candidate,
        } => {
            o.int("track", *track as u64);
            o.int("sample", *sample);
            if *freq != 0.0 {
                o.num("freq", *freq);
            }
            if *candidate {
                o.bool("candidate", true);
            }
        }
        Event::TrackConfirmed {
            track,
            sample,
            freq,
        } => {
            o.int("track", *track as u64);
            o.int("sample", *sample);
            if *freq != 0.0 {
                o.num("freq", *freq);
            }
        }
        Event::Commit {
            track,
            sample,
            freq,
            text,
            chars,
        } => {
            o.int("track", *track as u64);
            o.int("sample", *sample);
            if *freq != 0.0 {
                o.num("freq", *freq);
            }
            if !text.is_empty() {
                o.str("text", text);
            }
            if !chars.is_empty() {
                chars_json(o.key("chars"), chars, true);
            }
        }
        Event::Tentative {
            track,
            sample,
            held,
            text,
            pattern,
            guess,
            p,
            alts,
            candidate,
        } => {
            o.int("track", *track as u64);
            o.int("sample", *sample);
            if *candidate {
                o.bool("candidate", true);
            }
            if !text.is_empty() {
                o.str("text", text);
            }
            if !held.is_empty() {
                o.str("held", held);
            }
            if !pattern.is_empty() {
                o.str("pattern", pattern);
            }
            if !guess.is_empty() {
                o.str("guess", guess);
            }
            if *p != 0.0 {
                o.num("p", *p);
            }
            if !alts.is_empty() {
                guesses_json(o.key("alts"), alts);
            }
        }
        Event::Correction {
            track,
            sample,
            retract,
            text,
        } => {
            o.int("track", *track as u64);
            o.int("sample", *sample);
            o.int("retract", *retract as u64);
            o.str("text", text);
        }
        Event::TrackLost {
            track,
            sample,
            candidate,
        } => {
            o.int("track", *track as u64);
            o.int("sample", *sample);
            if *candidate {
                o.bool("candidate", true);
            }
        }
    }
    o.end();
}

/// Appends the track state as one JSON object (snapshot entry of the web app).
pub fn write_track(t: &TrackState, out: &mut String) {
    let mut o = Obj::new(out);
    o.int("track", t.track as u64);
    o.num("freq", t.freq);
    o.bool("candidate", t.candidate);
    o.num("snr", t.snr);
    o.num("level", t.level);
    o.num("wpm", t.wpm);
    o.num("ratio", t.ratio);
    o.num("bias", t.bias);
    o.bool("keyOn", t.key_on);
    o.num("evidence", t.evidence);
    o.key("pStation").push_str("null");
    chars_json(o.key("held"), &t.held, false);
    guesses_json(o.key("guesses"), &t.guesses);
    o.end();
}

/// JSON array of events.
pub fn events_json(evs: &[Event]) -> String {
    let mut s = String::from("[");
    for (i, e) in evs.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        write_event(e, &mut s);
    }
    s.push(']');
    s
}

/// JSON array of track states.
pub fn tracks_json(ts: &[TrackState]) -> String {
    let mut s = String::from("[");
    for (i, t) in ts.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        write_track(t, &mut s);
    }
    s.push(']');
    s
}
