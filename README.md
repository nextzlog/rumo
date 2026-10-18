rumo
====

![image](https://img.shields.io/badge/Rust-2021-red.svg)
![image](https://img.shields.io/badge/license-MIT-darkblue.svg)

rumo is a streaming Morse decoder library that reads every station in the audio band at once.

## Get Started

```toml
[dependencies]
rumo = { git = "https://github.com/nextzlog/rumo" }
```

```rust
let mut dec = rumo::Decoder::new(48000);
for block in audio.chunks(128) {
    for event in dec.push(block) {
        if let rumo::Event::Commit { freq, text, .. } = event {
            println!("{freq:.0} Hz: {text}");
        }
    }
}
let tail = dec.flush();
```

## Build

```sh
$ cargo build --release
$ cargo test
```

## Events

| Event | Fields | Meaning |
|---|---|---|
| TrackBorn | freq, candidate | A new track appears. |
| TrackConfirmed | freq | The candidate is a station. |
| Commit | freq, text, chars | Confirmed characters, never revised. |
| Tentative | held, text, pattern, guess, p, alts | Uncommitted state of a track. |
| Correction | retract, text | Reserved. |
| TrackLost | candidate | The track ended. |

Every event carries the track number and the sample index of its decision.

## Algorithm

Audio samples become events in 5 ms frames.

```mermaid
flowchart TD
  A[Audio samples] --> B[Hann window 40 ms, FFT every 5 ms]
  B --> C[Joint least-squares fit of all track lines with steady and ramp columns]
  C --> D[Residual spectrum]
  D --> E[Per-bin noise floor and local CFAR]
  E --> F[Birth candidates with skirt masking]
  F -->|persists 4 frames| G[New track with look-back replay of 0.8 s]
  C --> H[Track amplitude per frame]
  G --> H
  H --> I[Phase-advance frequency refinement]
  H --> J[Level keyer: noise and key-down levels]
  H --> K[Key-state network]
  J --> R[Rician likelihood]
  K --> L[Blend over the first 200 frames of a track]
  R --> L
  L --> M[Soft keyer: explicit-duration HSMM]
  M -->|marks, spaces and open gap| N[Timing model: speed grid and Morse tree]
  N --> O[Commit rule]
  O --> P[Events]
```

The key-state network turns seven features per track and frame into a key-down likelihood.

```mermaid
flowchart LR
  A[Own log power over noise reference] --> F[Normalise]
  B[Own log power over bin floor] --> F
  C[Own phase consistency] --> F
  D[Own log power below peak] --> F
  E[Strongest neighbour within 300 Hz: power, offset, phase consistency] --> F
  F --> G[GRU, 24 units]
  G --> H[Linear output over temperature]
  H --> I[Logit minus prior logit, times 0.75, clipped to 8]
  I --> J[Key-down log-likelihood ratio]
```

A track is a candidate until its keying is shown to be Morse from a real station.

```mermaid
stateDiagram-v2
  [*] --> Candidate: residual line persists
  Candidate --> Candidate: evidence below gate, text held
  Candidate --> Confirmed: evidence and two informative characters
  Candidate --> Rejected: onsets follow a stronger neighbour
  Candidate --> Lost: silent 2.5 s
  Confirmed --> Confirmed: commits
  Confirmed --> Lost: silent 6 s or merged
  Rejected --> Lost
  Lost --> [*]
```

The soft keyer chains forced stages per element type and ends each chain with a geometric tail.

```mermaid
stateDiagram-v2
  Dit --> ElementGap: 0.55
  Dit --> CharGap: 0.35
  Dit --> WordGap: 0.10
  Dah --> ElementGap: 0.55
  Dah --> CharGap: 0.35
  Dah --> WordGap: 0.10
  ElementGap --> Dit: 0.5
  ElementGap --> Dah: 0.5
  CharGap --> Dit: 0.5
  CharGap --> Dah: 0.5
  WordGap --> Dit: 0.5
  WordGap --> Dah: 0.5
```

Each block of samples is processed frame by frame, and the events are returned in order.

```mermaid
sequenceDiagram
  participant App
  participant Decoder
  participant Track
  App->>Decoder: push(samples)
  loop every completed frame
    Decoder->>Decoder: FFT, joint fit, noise floor
    Decoder->>Track: amplitude
    Track->>Track: network, keyers, timing, commit rule
    Decoder->>Decoder: births and deaths
    Decoder-->>App: TrackBorn, Commit, TrackConfirmed, Tentative, TrackLost
  end
```

A character is committed when its posterior is high enough or when it has waited long enough.

```mermaid
flowchart TD
  A[Element or open gap] --> B{Morse evidence above gate}
  B -->|no| Z[Wait]
  B -->|yes| C{Posterior of next character at least 0.99}
  C -->|yes| D[Commit]
  C -->|no| E{At least 6 events and posterior at least 0.9}
  E -->|yes| D
  E -->|no| F{At least 14 events}
  F -->|no| Z
  F -->|yes| G[Commit best guess as doubtful]
  H[Silence beyond 1.5 word gaps] --> I[Commit pending text if posterior at least 0.8]
```

## License

### Author

- JG1VPP
- JS2FVO

### Clauses

[MIT License](LICENSE)
