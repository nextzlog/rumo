//! Streaming multi-signal decoder core.
//!
//! Each frame (5 ms hop), the complex spectrum is explained as a sum of window-shaped
//! lines at the frequencies of the tracked stations, fitted jointly by least squares.
//! Lines that remain in the residual and persist become new tracks, decoded
//! retroactively from a look-back buffer. Each track refines its frequency from the
//! phase advance of its own amplitude, keys marks with a soft (HSMM) keyer, and decodes
//! characters with a timing model; characters are committed only when their
//! interpretation is unambiguous, and never revised.

use crate::complex::C64;
use crate::frontend::Frontend;
use crate::hsmm::SoftKeyer;
use crate::keyer::Keyer;
use crate::model::{CharMeta, Hyp, GAMMA};
use crate::nn::{self, NnState, INPUTS};
use crate::special::remainder;
use crate::timing::Timing;
use crate::{Config, Element};
use std::collections::{HashMap, VecDeque};

/// Gap in seconds assumed after the last element when a stream is flushed.
const FLUSH_GAP: f64 = 10.0;
/// Frames over which the per-bin noise floor starts as a running mean.
const FLOOR_WARMUP: i64 = 100;
/// Residual power above this multiple of the floor is excluded from the floor update.
const FLOOR_OUTLIER: f64 = 10.0;
/// Update rate of the log-domain noise floor after the warm-up.
const FLOOR_RATE: f64 = 0.01;
/// Frames of noise floor estimation before births are allowed.
const BIRTH_WARMUP: i64 = 40;
/// Weight of the previous value in the smoothed residual SNR per bin.
const SNR_KEEP: f64 = 0.6;
/// Weight of the new frame in the smoothed residual SNR per bin.
const SNR_NEW: f64 = 0.4;
/// Attenuation (dB) of a track's skirt mask next to its line.
const MASK_ATT_DB: f64 = 25.0;
/// Offset (Hz) beyond which the skirt mask attenuation grows.
const MASK_FLAT_HZ: f64 = 30.0;
/// Growth of the skirt mask attenuation in dB per Hz.
const MASK_SLOPE_DB_HZ: f64 = 0.1;
/// Largest skirt mask attenuation (dB).
const MASK_MAX_DB: f64 = 45.0;
/// Floor of the birth threshold relative to the strongest residual (dynamic range).
const BIRTH_RANGE: f64 = 1e-5;
/// Decay per frame of the remembered strongest residual.
const GMAX_DECAY: f64 = 0.9995;
/// Half width (Hz) of the frequency window of the local order statistic (CFAR).
const CFAR_HZ: f64 = 150.0;
/// Guard half width (Hz) excluded around the cell under test.
const CFAR_GUARD_HZ: f64 = 30.0;
/// Median of an exponential distribution relative to its mean.
const EXP_MEDIAN: f64 = 0.69;
/// Minimum spacing (Hz) of tracks born in the same frame.
const BIRTH_SPACING_HZ: f64 = 300.0;
/// The 33rd percentile of exponentially distributed power relative to its mean, for the
/// initial noise estimate (two roundings are used: a conservative one and the exact one).
const P33_LOW: f64 = 0.4;
const P33: f64 = 0.405;
/// The 10th percentile of exponentially distributed power relative to its mean.
const P10: f64 = 0.105;
/// Ratio of peak to quiet-third power below which keying may fill the quiet third.
const HIGH_DUTY: f64 = 10.0;
/// Smallest noise level relative to the peak.
const NOISE_MIN_REL: f64 = 1e-7;
/// Smallest initial key-down level relative to the noise.
const PEAK_MIN_REL: f64 = 10.0;
/// Silence (s) after which an unconfirmed track is dropped.
const CANDIDATE_DEAD_SEC: f64 = 2.5;
/// Value of `last_on` that marks a track for removal.
const KILL: i64 = 1 << 30;
/// Frame power above this multiple of the noise allows frequency refinement.
const REFINE_SNR: f64 = 10.0;
/// Gain of the phase-advance frequency refinement.
const REFINE_GAIN: f64 = 0.03;
/// Speed ambiguity at or below which the timing estimate is not trusted.
const AMBIG_LOW: f64 = 3.0;
/// Smallest key-down SNR given to the soft keyer.
const SOFT_SNR_MIN: f64 = 2.0;
/// A confirmed station within this distance (Hz) and this many dB above a track
/// outshines it.
const OUTSHONE_HZ: f64 = 300.0;
const OUTSHONE_DB: f64 = 6.0;
/// Number of keying edges remembered per track.
const EDGE_MEMORY: usize = 64;
/// Weight of the previous value in the smoothed key-down power.
const LEVEL_KEEP: f64 = 0.95;
/// Weight of the new frame in the smoothed key-down power.
const LEVEL_NEW: f64 = 0.05;
/// Decay per frame of the remembered peak power (masking).
const PEAK_DECAY: f64 = 0.98;
/// A neighbour at least this many times stronger can own a track's keying (ghost check).
const GHOST_LEVEL: f64 = 4.0;
/// Frequency range (Hz) of the ghost check.
const GHOST_HZ: f64 = 400.0;
/// Frames within which an onset coincides with a neighbour's edge.
const GHOST_FRAMES: i64 = 4;
/// Fraction of coinciding onsets that marks a ghost.
const GHOST_FRAC: f64 = 0.6;
/// Range (Hz) of louder neighbours that suspend frequency refinement.
const DOMINANCE_HZ: f64 = 80.0;
/// Scale of the network's log-odds in the soft keyer and its bound.
const NN_TAU: f64 = 0.75;
const NN_CLIP: f64 = 8.0;
/// Frames over which a new track's likelihood moves from the Rician model to the network.
const NN_BLEND: u32 = 200;
/// Release of the log-power peak follower per frame (about 43 dB/s).
const NN_PEAK_RELEASE: f64 = 0.05;
/// The noise reference stays within this log-power distance below the peak (40 dB).
const NN_RANGE: f64 = 9.2;
/// Up and down steps of the noise quantile tracker (about the 20th percentile).
const NN_UP: f64 = 0.005;
const NN_DOWN: f64 = 0.02;
/// Bounds of the log-power features.
const NN_LA: (f64, f64) = (-10.0, 15.0);
const NN_LB: (f64, f64) = (-10.0, 20.0);
const NN_LP: (f64, f64) = (-15.0, 0.0);
/// Range (Hz) of the neighbour features.
const NN_NEIGHBOUR_HZ: f64 = 300.0;
/// Smallest power in a logarithm.
const POWER_MIN: f64 = 1e-30;
/// Regularisation of the joint fit relative to the mean diagonal of the Gram matrix.
const FIT_REG: f64 = 1e-3;

/// Committed text of one track (internal event).
#[derive(Clone, Debug)]
pub struct Out {
    pub track: u32,
    pub freq: f64,
    pub text: String,
    pub meta: Vec<CharMeta>,
}

#[derive(Clone, Copy)]
struct Edge {
    fr: i64,
    on: bool,
}

pub struct Track {
    pub id: u32,
    /// Frequency in fractional bins of the zero-padded FFT.
    pub nu: f64,
    c: C64,
    prev_c: C64,
    pub key: Keyer,
    pub tim: Timing,
    pub confirmed: bool,
    born: i64,
    pub level: f64,
    edges: VecDeque<Edge>,
    peak_e: f64,
    pub sk: Option<SoftKeyer>,
    nst: NnState,
}

/// Snapshot of one track in one frame (neighbour features of the key-state network).
#[derive(Clone, Copy)]
struct NbRec {
    id: u32,
    nu: f64,
    la: f64,
    pc: f64,
    level: f64,
}

/// Parameters shared by the per-track functions.
struct Ctx<'a> {
    cfg: &'a Config,
    rate: f64,
    m: f64,
    /// Per-bin noise floor, its first bin and the energy of a line in the bins.
    floor: &'a [f64],
    lo: usize,
    knorm: f64,
}

impl Ctx<'_> {
    #[inline]
    fn hz(&self, nu: f64) -> f64 {
        nu * self.rate / self.m
    }

    #[inline]
    fn hz_bin(&self, f: f64) -> f64 {
        f * self.m / self.rate
    }

    /// Noise floor at the bin nearest to frequency nu (bins).
    fn noise_at(&self, nu: f64) -> f64 {
        let k = (nu.round() as i64 - self.lo as i64).clamp(0, self.floor.len() as i64 - 1);
        self.floor[k as usize]
    }
}

pub struct Core {
    pub cfg: Config,
    pub fe: Frontend,
    pub tracks: Vec<Track>,
    next_id: u32,
    floor: Vec<f64>,
    logm: Vec<f64>,
    nfloor: i64,
    smooth: Vec<f64>,
    cand: HashMap<i64, i64>,
    ring: VecDeque<(Vec<C64>, Vec<NbRec>)>,
    pub frame_no: i64,
    pub out: Vec<Out>,
    gmax: f64,
    spec: Vec<C64>,
    /// Keyer output (track, frame, element) when recording is enabled.
    pub elements: Option<Vec<(u32, i64, Element)>>,
}

impl Core {
    pub fn new(rate: usize, cfg: Config) -> Core {
        let fe = Frontend::new(rate, cfg.win_sec, cfg.lo_hz, cfg.hi_hz);
        let nb = fe.hi - fe.lo;
        Core {
            cfg,
            fe,
            tracks: Vec::new(),
            next_id: 0,
            floor: vec![0.0; nb],
            logm: vec![0.0; nb],
            nfloor: 0,
            smooth: vec![0.0; nb],
            cand: HashMap::new(),
            ring: VecDeque::new(),
            frame_no: 0,
            out: Vec::new(),
            gmax: 0.0,
            spec: Vec::new(),
            elements: None,
        }
    }

    #[inline]
    pub fn hz(&self, nu: f64) -> f64 {
        self.fe.bin_hz(nu)
    }

    /// Frame hop in seconds.
    pub fn frame_seconds(&self) -> f64 {
        self.fe.hop as f64 / self.fe.rate as f64
    }

    /// Appends samples to the input buffer.
    pub fn feed(&mut self, x: impl Iterator<Item = f64>) {
        self.fe.feed(x);
    }

    /// Processes the next complete frame, if any, and returns its end sample.
    pub fn next_frame(&mut self) -> Option<usize> {
        let mut spec = std::mem::take(&mut self.spec);
        let r = self.fe.next_frame(&mut spec).map(|start| {
            self.frame(&spec);
            start + self.fe.n
        });
        self.spec = spec;
        r
    }

    /// Finalises all tracks (end of stream).
    pub fn flush(&mut self) {
        let ctx = Ctx {
            cfg: &self.cfg,
            rate: self.fe.rate as f64,
            m: self.fe.m as f64,
            floor: &self.floor,
            lo: self.fe.lo,
            knorm: self.fe.kernel.norm,
        };
        for t in &mut self.tracks {
            t.tim.tick(t.key.gap() + FLUSH_GAP, true, true);
            t.tim.release();
            let f = ctx.hz(t.nu);
            deliver(&mut self.out, t, f);
        }
    }

    /// Joint least squares for all tracks; returns the residual.
    fn fit(&mut self, spec: &[C64]) -> Vec<C64> {
        let mut resid = spec.to_vec();
        let lo = self.fe.lo as f64;
        let k = &self.fe.kernel;
        self.tracks
            .sort_by(|a, b| a.nu.partial_cmp(&b.nu).unwrap_or(std::cmp::Ordering::Equal));
        let mut i = 0;
        while i < self.tracks.len() {
            let mut j = i + 1;
            while j < self.tracks.len() && self.tracks[j].nu - self.tracks[j - 1].nu < 2.0 * k.r {
                j += 1;
            }
            let cl = &mut self.tracks[i..j];
            let b0 = (cl[0].nu - k.r - lo).floor().max(0.0) as usize;
            let b1 = (cl[cl.len() - 1].nu + k.r - lo)
                .ceil()
                .min((spec.len() - 1) as f64) as usize;
            let n = 2 * cl.len();
            let w = b1 - b0 + 1;
            let mut g = vec![C64::ZERO; n * n];
            let mut h = vec![C64::ZERO; n];
            let mut cols = vec![C64::ZERO; n * w];
            for (a, t) in cl.iter().enumerate() {
                for kk in b0..=b1 {
                    cols[2 * a * w + kk - b0] = k.at(kk as f64 + lo - t.nu);
                    cols[(2 * a + 1) * w + kk - b0] = k.ramp(kk as f64 + lo - t.nu);
                }
            }
            for a in 0..n {
                for b in a..n {
                    let mut s = C64::ZERO;
                    for q in 0..w {
                        s += cols[a * w + q].conj() * cols[b * w + q];
                    }
                    g[a * n + b] = s;
                    g[b * n + a] = s.conj();
                }
                let mut s = C64::ZERO;
                for q in 0..w {
                    s += cols[a * w + q].conj() * spec[b0 + q];
                }
                h[a] = s;
            }
            let mut reg = 0.0;
            for a in 0..n {
                reg += g[a * n + a].re;
            }
            reg = FIT_REG * reg / n as f64;
            for a in 0..n {
                g[a * n + a] += C64::new(reg, 0.0);
            }
            let c = solve(&mut g, &mut h, n);
            for (a, t) in cl.iter_mut().enumerate() {
                t.prev_c = t.c;
                t.c = c[2 * a];
                for q in 0..2 {
                    let col = &cols[(2 * a + q) * w..(2 * a + q + 1) * w];
                    for (kk, &cv) in col.iter().enumerate() {
                        resid[b0 + kk] -= c[2 * a + q] * cv;
                    }
                }
            }
            i = j;
        }
        resid
    }

    fn frame(&mut self, spec: &[C64]) {
        self.frame_no += 1;
        let resid = self.fit(spec);
        for (k, v) in resid.iter().enumerate() {
            let p = v.re * v.re + v.im * v.im + 1e-30;
            let lp = p.ln();
            if self.nfloor == 0 {
                self.logm[k] = lp;
            } else if p < FLOOR_OUTLIER * self.floor[k] || self.nfloor < FLOOR_WARMUP {
                let a = if self.nfloor < FLOOR_WARMUP {
                    1.0 / (self.nfloor + 1) as f64
                } else {
                    FLOOR_RATE
                };
                self.logm[k] += a * (lp - self.logm[k]);
            }
            self.floor[k] = (self.logm[k] + GAMMA).exp();
        }
        self.nfloor += 1;
        let dt = self.frame_seconds();
        let nb = self.snapshot(dt);
        for i in 0..self.tracks.len() {
            let ctx = Ctx {
                cfg: &self.cfg,
                rate: self.fe.rate as f64,
                m: self.fe.m as f64,
                floor: &self.floor,
                lo: self.fe.lo,
                knorm: self.fe.kernel.norm,
            };
            let (a, rest) = self.tracks.split_at_mut(i);
            let (t, b) = rest.split_first_mut().unwrap();
            let c = t.c;
            advance(
                &ctx,
                t,
                (a, b),
                c,
                dt,
                self.frame_no,
                true,
                &nb,
                &mut self.out,
                &mut self.elements,
            );
        }
        self.ring.push_back((resid.clone(), nb));
        if self.ring.len() > self.cfg.lookback {
            self.ring.pop_front();
        }
        if self.nfloor > BIRTH_WARMUP {
            self.births(&resid, dt);
        }
        self.prune(dt);
    }

    fn births(&mut self, resid: &[C64], dt: f64) {
        let nb = resid.len();
        let mut snr = vec![0.0; nb];
        for (k, v) in resid.iter().enumerate() {
            let p = v.re * v.re + v.im * v.im;
            self.smooth[k] = SNR_KEEP * self.smooth[k] + SNR_NEW * p / self.floor[k];
            snr[k] = self.smooth[k];
        }
        let th = 10f64.powf(self.cfg.birth_db / 10.0);
        let k0 = self.fe.kernel.at(0.0).abs();
        let k0 = k0 * k0;
        let mut mask = vec![0.0; nb];
        for t in &self.tracks {
            let pk = t.peak_e.max(t.c.re * t.c.re + t.c.im * t.c.im) * k0;
            for (k, mk) in mask.iter_mut().enumerate() {
                let df = self.hz((k + self.fe.lo) as f64 - t.nu).abs();
                let mut att = MASK_ATT_DB + MASK_SLOPE_DB_HZ * (df - MASK_FLAT_HZ).max(0.0);
                if att > MASK_MAX_DB {
                    att = MASK_MAX_DB;
                }
                let m = pk * 10f64.powf(-att / 10.0);
                if m > *mk {
                    *mk = m;
                }
            }
        }
        let mut gmax = 0.0;
        for k in 0..nb {
            let v = snr[k] * self.floor[k];
            if v > gmax {
                gmax = v;
            }
        }
        // local order statistic across frequency (CFAR)
        let mut loc = vec![0.0; nb];
        let ww = self.fe.hz_bin(CFAR_HZ) as i64;
        let gg = self.fe.hz_bin(CFAR_GUARD_HZ) as i64;
        let mut buf: Vec<f64> = Vec::with_capacity(2 * ww as usize + 2);
        for k in 0..nb as i64 {
            buf.clear();
            for j in k - ww..=k + ww {
                if j < 0 || j >= nb as i64 || (j >= k - gg && j <= k + gg) {
                    continue;
                }
                buf.push(self.smooth[j as usize] * self.floor[j as usize]);
            }
            buf.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            loc[k as usize] = buf[buf.len() / 2] / EXP_MEDIAN;
        }
        for k in 0..nb {
            let mut eff = self.floor[k].max(mask[k].max(BIRTH_RANGE * gmax.max(self.gmax)));
            eff = eff.max(loc[k]);
            snr[k] = self.smooth[k] * self.floor[k] / eff;
        }
        if gmax > self.gmax {
            self.gmax = gmax;
        } else {
            self.gmax *= GMAX_DECAY;
        }
        let mut seen: Vec<i64> = Vec::new();
        let mut rs: Vec<(f64, f64)> = Vec::new();
        for k in 2..nb.saturating_sub(2) {
            if snr[k] < th
                || snr[k] < snr[k - 1]
                || snr[k] < snr[k + 1]
                || snr[k] < snr[k - 2]
                || snr[k] < snr[k + 2]
            {
                continue;
            }
            let mut key = k as i64;
            for kk in [k as i64 - 1, k as i64 + 1] {
                if self.cand.contains_key(&kk) {
                    key = kk;
                }
            }
            seen.push(key);
            let cnt = self.cand.entry(key).or_insert(0);
            *cnt += 1;
            if *cnt < self.cfg.birth_run {
                continue;
            }
            let (l, c, r) = (snr[k - 1], snr[k], snr[k + 1]);
            let mut nu = (k + self.fe.lo) as f64;
            let den = l - 2.0 * c + r;
            if den != 0.0 {
                nu += 0.5 * (l - r) / den;
            }
            rs.push((nu, snr[k]));
        }
        rs.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        let mut born: Vec<f64> = Vec::new();
        for &(nu, _) in &rs {
            let mut ok = !self.near(nu);
            for &b in &born {
                if self.hz(b - nu).abs() < BIRTH_SPACING_HZ {
                    ok = false;
                }
            }
            if !ok {
                continue;
            }
            born.push(nu);
            let k = nu.round() as i64 - self.fe.lo as i64;
            self.cand.remove(&k);
            self.cand.remove(&(k - 1));
            self.cand.remove(&(k + 1));
            self.spawn(nu, dt);
        }
        self.cand.retain(|k, _| seen.contains(k));
    }

    fn near(&self, nu: f64) -> bool {
        self.tracks
            .iter()
            .any(|t| self.hz(t.nu - nu).abs() < self.cfg.min_sep_hz)
    }

    /// Creates a track and replays the look-back buffer through it.
    fn spawn(&mut self, nu: f64, dt: f64) {
        let mut t = Track {
            id: self.next_id,
            nu,
            c: C64::ZERO,
            prev_c: C64::ZERO,
            key: Keyer::new(dt),
            tim: Timing::new(),
            confirmed: false,
            born: self.frame_no,
            level: 0.0,
            edges: VecDeque::new(),
            peak_e: 0.0,
            sk: None,
            nst: NnState::default(),
        };
        self.next_id += 1;
        let k = &self.fe.kernel;
        let lo = self.fe.lo as f64;
        let mut norm = 0.0;
        let b0 = (nu - k.r - lo).floor().max(0.0) as usize;
        let b1 = (nu + k.r - lo).ceil().min((self.floor.len() - 1) as f64) as usize;
        let cols: Vec<C64> = (b0..=b1).map(|kk| k.at(kk as f64 + lo - nu)).collect();
        for cv in &cols {
            norm += cv.re * cv.re + cv.im * cv.im;
        }
        let mut cs = Vec::with_capacity(self.ring.len());
        let mut es = Vec::with_capacity(self.ring.len());
        for (f, _) in &self.ring {
            let mut s = C64::ZERO;
            for kk in b0..=b1 {
                s += cols[kk - b0].conj() * f[kk];
            }
            let c = s / C64::new(norm, 0.0);
            cs.push(c);
            es.push(c.re * c.re + c.im * c.im);
        }
        let mut sorted = es.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let n = sorted.len();
        let q = sorted[n / 3];
        t.key.peak = sorted[n - 1];
        t.key.noise = (q / P33_LOW).max(t.key.peak * NOISE_MIN_REL);
        if q >= sorted[n - 1] / HIGH_DUTY {
            let nz = (q / P33).min(sorted[n / 10] / P10);
            t.key.noise = nz.max(t.key.peak * NOISE_MIN_REL);
        }
        t.key.peak = t.key.peak.max(t.key.noise * PEAK_MIN_REL);
        let first = self.frame_no - cs.len() as i64 + 1;
        let ctx = Ctx {
            cfg: &self.cfg,
            rate: self.fe.rate as f64,
            m: self.fe.m as f64,
            floor: &self.floor,
            lo: self.fe.lo,
            knorm: self.fe.kernel.norm,
        };
        for (i, &c) in cs.iter().enumerate() {
            t.prev_c = t.c;
            t.c = c;
            let nb = &self.ring[i].1;
            advance(
                &ctx,
                &mut t,
                (&self.tracks, &[]),
                c,
                dt,
                first + i as i64,
                false,
                nb,
                &mut self.out,
                &mut self.elements,
            );
        }
        self.tracks.push(t);
    }

    fn prune(&mut self, dt: f64) {
        let (rate, m) = (self.fe.rate as f64, self.fe.m as f64);
        let tracks = std::mem::take(&mut self.tracks);
        for mut t in tracks {
            let silent = t.key.last_on as f64 * dt;
            let mut dead = silent > self.cfg.dead_sec;
            if !t.confirmed && silent > CANDIDATE_DEAD_SEC {
                dead = true;
            }
            if dead {
                if t.confirmed {
                    t.tim.tick(t.key.gap(), true, true);
                    t.tim.release();
                    let f = t.nu * rate / m;
                    deliver(&mut self.out, &mut t, f);
                }
                continue;
            }
            self.tracks.push(t);
        }
        self.tracks
            .sort_by(|a, b| a.nu.partial_cmp(&b.nu).unwrap_or(std::cmp::Ordering::Equal));
        for i in 1..self.tracks.len() {
            let (a, b) = (&self.tracks[i - 1], &self.tracks[i]);
            if self.hz(b.nu - a.nu).abs() < self.cfg.min_sep_hz {
                let drop = if b.born < a.born { i - 1 } else { i };
                self.tracks[drop].key.last_on = KILL;
                self.tracks[drop].confirmed = false;
            }
        }
    }
}

/// Gaussian elimination with partial pivoting for a small complex system.
fn solve(a: &mut [C64], b: &mut [C64], n: usize) -> Vec<C64> {
    for col in 0..n {
        let mut p = col;
        for r in col + 1..n {
            if a[r * n + col].abs() > a[p * n + col].abs() {
                p = r;
            }
        }
        if p != col {
            for k in 0..n {
                a.swap(col * n + k, p * n + k);
            }
            b.swap(col, p);
        }
        let piv = a[col * n + col];
        if piv.is_zero() {
            continue;
        }
        for r in col + 1..n {
            let f = a[r * n + col] / piv;
            for k in col..n {
                let v = f * a[col * n + k];
                a[r * n + k] -= v;
            }
            let v = f * b[col];
            b[r] -= v;
        }
    }
    let mut x = vec![C64::ZERO; n];
    for r in (0..n).rev() {
        let mut s = b[r];
        for k in r + 1..n {
            s -= a[r * n + k] * x[k];
        }
        if !a[r * n + r].is_zero() {
            x[r] = s / a[r * n + r];
        }
    }
    x
}

fn deliver(out: &mut Vec<Out>, t: &mut Track, freq: f64) {
    if t.tim.out().is_empty() {
        return;
    }
    let (text, meta) = t.tim.take_out();
    out.push(Out {
        track: t.id,
        freq,
        text,
        meta,
    });
}

type Others<'a> = (&'a [Track], &'a [Track]);

fn others_iter<'a>(o: Others<'a>) -> impl Iterator<Item = &'a Track> {
    o.0.iter().chain(o.1.iter())
}

/// Feeds one frame of a track's amplitude through keyer and timing.
/// `live` is false while replaying the look-back buffer at birth.
#[allow(clippy::too_many_arguments)]
fn advance(
    ctx: &Ctx,
    t: &mut Track,
    others: Others,
    c: C64,
    dt: f64,
    fr: i64,
    live: bool,
    nb: &[NbRec],
    out: &mut Vec<Out>,
    elements: &mut Option<Vec<(u32, i64, Element)>>,
) {
    let cfg = ctx.cfg;
    let e = c.re * c.re + c.im * c.im;
    let feats = features(ctx, t, c, e, dt, nb);
    // phase-advance frequency refinement on strong frames
    if live
        && t.key.on
        && !t.prev_c.is_zero()
        && e > REFINE_SNR * t.key.noise
        && !dominated(ctx, t, others, e)
    {
        let want = 2.0 * std::f64::consts::PI * ctx.hz(t.nu) * dt;
        let dphi = remainder(
            (c * t.prev_c.conj()).arg() - want,
            2.0 * std::f64::consts::PI,
        );
        t.nu += REFINE_GAIN * ctx.hz_bin(dphi / (2.0 * std::f64::consts::PI * dt));
    }
    let mut unit = t.tim.best().u;
    if t.tim.ambig() <= AMBIG_LOW {
        unit = 0.0;
    }
    let was = t.key.on;
    t.key.step(e, unit, |_| {});
    let sk =
        t.sk.get_or_insert_with(|| SoftKeyer::new(dt, cfg.kappa, cfg.k_frac));
    let best: Hyp = t.tim.best();
    sk.build(best, t.tim.ambig() <= AMBIG_LOW);
    let s = (t.key.peak / t.key.noise - 1.0).max(SOFT_SNR_MIN);
    let x = e / t.key.noise;
    // key-down log-likelihood ratio from the network, blended from the Rician model
    // over the first frames of a track (the network has no history of a new station)
    let lg = nn::step(&mut t.nst, &feats);
    t.nst.age += 1;
    let mut llr = (NN_TAU * (lg - nn::prior_logit())).clamp(-NN_CLIP, NN_CLIP);
    if t.nst.age < NN_BLEND {
        let w = t.nst.age as f64 / NN_BLEND as f64;
        llr = w * llr + (1.0 - w) * sk.rician_llr(x, s);
    }
    // a weak station next to a clearly stronger one holds doubtful characters back
    let lvl = t.level * 10f64.powf(OUTSHONE_DB / 10.0);
    t.tim.c.outshone = others_iter(others)
        .any(|o| o.confirmed && ctx.hz(o.nu - t.nu).abs() <= OUTSHONE_HZ && o.level > lvl);
    let tim = &mut t.tim;
    let id = t.id;
    sk.step(llr, |el| {
        if let Some(log) = elements.as_mut() {
            log.push((id, fr, el));
        }
        tim.add_element(el)
    });
    if t.key.on != was {
        t.edges.push_back(Edge {
            fr: fr - t.key.min_run,
            on: t.key.on,
        });
        if t.edges.len() > EDGE_MEMORY {
            t.edges.pop_front();
        }
    }
    if t.key.on {
        t.level = LEVEL_KEEP * t.level + LEVEL_NEW * e;
    }
    t.peak_e = e.max(t.peak_e * PEAK_DECAY);
    let sk = t.sk.as_ref().unwrap();
    let gap_now = sk.gap();
    let ev = sk.evidence(cfg.ev_win);
    if ev < cfg.ev_alive {
        if !t.confirmed {
            t.tim.discard_held();
        }
        return;
    }
    if live && !t.confirmed && ev < cfg.ev_conf {
        t.tim.tick(gap_now, false, false);
        return;
    }
    if live && !t.confirmed && t.tim.nchars() >= cfg.conf_chars {
        if ghost_of(ctx, t, others) {
            t.key.last_on = KILL; // its keying is a stronger neighbour's: a skirt, not a station
            return;
        }
        t.confirmed = true;
        t.tim.release();
    }
    t.tim.tick(gap_now, t.confirmed, false);
    t.tim.open_gap(gap_now, t.confirmed);
    if live {
        let f = ctx.hz(t.nu);
        deliver(out, t, f);
    }
}

/// Whether most of the track's onsets coincide with edges of a clearly stronger nearby track.
fn ghost_of(ctx: &Ctx, t: &Track, others: Others) -> bool {
    let ons: Vec<i64> = t.edges.iter().filter(|e| e.on).map(|e| e.fr).collect();
    if ons.len() < 3 {
        return false;
    }
    for o in others_iter(others) {
        if o.level < GHOST_LEVEL * t.level || ctx.hz(o.nu - t.nu).abs() > GHOST_HZ {
            continue;
        }
        let mut hit = 0;
        for &f in &ons {
            if o.edges
                .iter()
                .any(|e| f - e.fr <= GHOST_FRAMES && e.fr - f <= GHOST_FRAMES)
            {
                hit += 1;
            }
        }
        if hit as f64 >= GHOST_FRAC * ons.len() as f64 {
            return true;
        }
    }
    false
}

/// Whether a stronger track within 80 Hz is louder in this frame.
fn dominated(ctx: &Ctx, t: &Track, others: Others, e: f64) -> bool {
    others_iter(others)
        .any(|o| ctx.hz(o.nu - t.nu).abs() <= DOMINANCE_HZ && o.c.re * o.c.re + o.c.im * o.c.im > e)
}

/// Cosine of the deviation of a frame's phase advance from the advance expected at the
/// track frequency (1 for a steady carrier, 0 when undefined).
fn phase_cons(c: C64, prev: C64, hz: f64, dt: f64) -> f64 {
    if prev.is_zero() || c.is_zero() {
        return 0.0;
    }
    let want = 2.0 * std::f64::consts::PI * hz * dt;
    remainder((c * prev.conj()).arg() - want, 2.0 * std::f64::consts::PI).cos()
}

#[inline]
fn clamp(x: f64, b: (f64, f64)) -> f64 {
    x.min(b.1).max(b.0)
}

impl Core {
    /// Records all tracks of the current frame (after the fit) for neighbour features.
    fn snapshot(&self, dt: f64) -> Vec<NbRec> {
        self.tracks
            .iter()
            .map(|t| {
                let mut la = t.nst.la;
                if t.nst.init {
                    let e = t.c.re * t.c.re + t.c.im * t.c.im;
                    la = clamp(e.max(POWER_MIN).ln() - t.nst.nf, NN_LA);
                }
                NbRec {
                    id: t.id,
                    nu: t.nu,
                    la,
                    pc: phase_cons(t.c, t.prev_c, self.hz(t.nu), dt),
                    level: t.level,
                }
            })
            .collect()
    }
}

/// Input features of the key-state network for track t in one frame.
fn features(ctx: &Ctx, t: &mut Track, c: C64, e: f64, dt: f64, nb: &[NbRec]) -> [f32; INPUTS] {
    let st = &mut t.nst;
    let l = e.max(POWER_MIN).ln();
    if !st.init {
        // start from the birth estimate of the noise, which does not depend on the keyer
        st.nf = t.key.noise.max(POWER_MIN).ln();
        st.init = true;
        st.pk = l;
    }
    st.pk = l.max(st.pk - NN_PEAK_RELEASE);
    st.nf = st.nf.max(st.pk - NN_RANGE);
    let la = clamp(l - st.nf, NN_LA);
    if l > st.nf {
        st.nf += NN_UP;
    } else {
        st.nf -= NN_DOWN;
    }
    st.la = la;
    let floor = (ctx.noise_at(t.nu).max(POWER_MIN) / ctx.knorm).ln();
    let lb = clamp(l - floor.max(st.pk - NN_RANGE), NN_LB);
    let mut f = [0f32; INPUTS];
    f[0] = la as f32;
    f[1] = lb as f32;
    f[2] = phase_cons(c, t.prev_c, ctx.hz(t.nu), dt) as f32;
    f[3] = clamp(l - st.pk, NN_LP) as f32;
    f[4] = 0.0;
    f[5] = 1.0;
    f[6] = 0.0;
    let mut best = -1.0;
    for o in nb {
        if o.id == t.id {
            continue;
        }
        let df = ctx.hz(o.nu - t.nu).abs();
        if df > NN_NEIGHBOUR_HZ || o.level <= best {
            continue;
        }
        best = o.level;
        f[4] = o.la as f32;
        f[5] = (df / NN_NEIGHBOUR_HZ) as f32;
        f[6] = o.pc as f32;
    }
    f
}
