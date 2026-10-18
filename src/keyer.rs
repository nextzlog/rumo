//! Hard keyer: turns a track's power series into marks and spaces with
//! fading-following thresholds; also maintains the track's noise and key-down levels.

use crate::model::GAMMA;
use crate::Element;

/// Smallest key-down level relative to the noise with the unbiased (log-domain) floor.
const PEAK_FLOOR: f64 = 8.0;
/// Smallest key-down level relative to the noise with the conservative (linear) floor.
const PEAK_FLOOR_LINEAR: f64 = 4.0;
/// The power smoother spans one unit divided by this (at most `SMOOTH_MAX` frames).
const SMOOTH_DIV: f64 = 3.0;
const SMOOTH_MAX: i64 = 6;
/// Smallest power considered (avoids log of zero).
const POWER_MIN: f64 = 1e-30;
/// Initial key-down level relative to the first noise estimate.
const PEAK_INIT: f64 = 100.0;
/// The threshold is at most this many dB below the key-down level (timing accuracy).
const THRESH_BELOW_PEAK_DB: f64 = 8.0;
/// Lowest threshold above the noise (dB).
const THRESH_MIN_DB: f64 = 4.5;
/// Hysteresis around the threshold (dB).
const HYSTERESIS_DB: f64 = 1.0;
/// Fast attack and slow release of the key-down level.
const ATTACK: f64 = 0.5;
const RELEASE: f64 = 0.03;
/// Update rate of the linear noise floor.
const NOISE_RATE: f64 = 0.02;
/// Update rate of the log-domain noise floor.
const LOG_NOISE_RATE: f64 = 0.03;
/// Frames after a transition before the log-domain floor is updated.
const SETTLE: i64 = 3;
/// Smallest noise level relative to the key-down level.
const NOISE_MIN_REL: f64 = 1e-7;
/// Decay per frame of the key-down level during silence.
const PEAK_DECAY: f64 = 0.999;

pub struct Keyer {
    dt: f64,
    pub noise: f64,
    pub peak: f64,
    pub on: bool,
    run: i64,
    smooth: Vec<f64>,
    hold: i64,
    pub min_run: i64,
    /// Frames since the last mark ended (for death).
    pub last_on: i64,
    marks: i64,
    snr_peak: f64,
    logn: f64,
    noise_c: f64,
    pub unbiased: bool,
}

impl Keyer {
    pub fn new(dt: f64) -> Keyer {
        Keyer {
            dt,
            noise: 0.0,
            peak: 0.0,
            on: false,
            run: 0,
            smooth: Vec::with_capacity(8),
            hold: 0,
            min_run: 2,
            last_on: 0,
            marks: 0,
            snr_peak: 0.0,
            logn: 0.0,
            noise_c: 0.0,
            unbiased: false,
        }
    }

    /// Consumes one frame of power; completed elements are returned through `emit`.
    pub fn step(&mut self, e: f64, unit: f64, mut emit: impl FnMut(Element)) {
        let mut n = 1usize;
        if unit > 0.0 {
            let v = (unit / SMOOTH_DIV / self.dt).round() as i64;
            n = v.clamp(1, SMOOTH_MAX) as usize;
        }
        self.smooth.push(e);
        if self.smooth.len() > n {
            let k = self.smooth.len() - n;
            self.smooth.drain(..k);
        }
        let mut s = 0.0;
        for &v in &self.smooth {
            s += v;
        }
        s /= self.smooth.len() as f64;

        if self.noise == 0.0 {
            self.noise = s.max(POWER_MIN);
            self.peak = self.noise * PEAK_INIT;
        }
        let ldb = 10.0 * (s.max(POWER_MIN) / self.noise).log10();
        let pdb = 10.0 * (self.peak / self.noise).log10();
        let mid = (pdb / 2.0)
            .max(pdb - THRESH_BELOW_PEAK_DB)
            .max(THRESH_MIN_DB);
        let (th_on, th_off) = (mid + HYSTERESIS_DB, mid - HYSTERESIS_DB);

        let mut want = self.on;
        if !self.on && ldb > th_on {
            want = true;
        } else if self.on && ldb < th_off {
            want = false;
        }
        if want != self.on {
            self.hold += 1;
            if self.hold >= self.min_run {
                let d = self.run as f64 * self.dt;
                emit(Element { mark: self.on, d });
                if self.on {
                    self.marks += 1;
                }
                self.on = want;
                self.run = self.hold;
                self.hold = 0;
            }
        } else {
            self.hold = 0;
            self.run += 1;
        }
        if self.on {
            if s > self.peak {
                self.peak = (1.0 - ATTACK) * self.peak + ATTACK * s;
            } else {
                self.peak = (1.0 - RELEASE) * self.peak + RELEASE * s;
            }
            self.last_on = 0;
            if ldb > self.snr_peak {
                self.snr_peak = ldb;
            }
        } else {
            self.last_on += 1;
            if self.noise_c == 0.0 {
                self.noise_c = self.noise;
            }
            self.noise_c = (1.0 - NOISE_RATE) * self.noise_c + NOISE_RATE * s;
            // log-domain (geometric) mean of raw frame power, away from transitions
            if self.logn == 0.0 {
                self.logn = self.noise.ln() - GAMMA;
            }
            if self.run > SETTLE && self.hold == 0 {
                self.logn += LOG_NOISE_RATE * (e.max(self.peak * NOISE_MIN_REL).ln() - self.logn);
            }
            if self.unbiased {
                self.noise = (self.logn + GAMMA).exp();
            } else {
                self.noise = self.noise_c;
            }
            self.noise = self.noise.max(self.peak * NOISE_MIN_REL);
            let pf = if self.unbiased {
                PEAK_FLOOR
            } else {
                PEAK_FLOOR_LINEAR
            };
            self.peak = (self.noise * pf).max(self.peak * PEAK_DECAY);
        }
    }

    /// Duration of the open space, or 0 while a mark is on.
    pub fn gap(&self) -> f64 {
        if self.on {
            0.0
        } else {
            self.run as f64 * self.dt
        }
    }
}
