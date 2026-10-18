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
| Token | start, text, kind, verdict | A closed token of committed text with its syntax verdict. |
| Correction | retract, text | Reserved. |
| TrackLost | candidate | The track ended. |

Every event carries the track number and the sample index of its decision.

## Algorithm

Audio samples become events in 5 ms frames.

```mermaid
flowchart TD
  A[Audio samples] --> B[Hann window 40 ms, FFT every 5 ms]
  B --> C[Joint least-squares fit of all track lines with steady and ramp columns, quadrature ramp held near its slow average]
  C --> D[Residual spectrum]
  D --> E[Per-bin noise floor and local CFAR]
  E --> F[Birth candidates: reset below the steady skirt, frozen below the skirt or edge leakage of louder tracks]
  F -->|counted 4 frames| Q[Joint position of the new line beside nearby tracks]
  Q --> G[New track with look-back replay of 0.8 s]
  C --> H[Track amplitude per frame]
  G --> H
  C --> S[Keying-edge leakage of louder tracks]
  H --> I[Phase-advance frequency refinement]
  H --> J[Level keyer: noise and key-down levels]
  H --> K[Key-state network, fed the last clean frame under strong leakage]
  S --> K
  J --> R[Rician likelihood]
  K --> L[Blend over the first 200 frames of a track]
  R --> L
  L --> T[Shrink towards zero by the leakage]
  S --> T
  T --> M[Soft keyer: explicit-duration HSMM]
  M -->|marks, spaces and open gap| N[Timing model: speed grid, Morse tree and character prior]
  N --> O[Commit rule]
  O --> P[Events]
```

The key-state network turns seven features per track and frame into a key-down likelihood.
Its neighbour inputs describe only a neighbour beyond the 150 Hz reach of keying-edge leakage, because a closer one made it follow the neighbour's keying; closer neighbours are handled by the joint fit, the edge leakage model and the common-fate checks.

```mermaid
flowchart LR
  A[Own log power over noise reference] --> F[Normalise]
  B[Own log power over bin floor] --> F
  C[Own phase consistency] --> F
  D[Own log power below peak] --> F
  E[Strongest neighbour 150 to 300 Hz away: power, offset, phase consistency] --> F
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
  Candidate --> Confirmed: evidence and two confident informative characters
  Candidate --> Rejected: onsets follow a stronger neighbour's edges beyond chance, never keyed while it is silent
  Candidate --> Lost: both keyers silent 2.5 s
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
  C -->|yes| V{Much stronger station within 70 Hz and the character's elements or the space before it under its keying edges}
  V -->|no| D[Commit]
  V -->|yes| O
  C -->|no| E{At least 6 events, posterior at least 0.9, no much stronger station within 70 Hz}
  E -->|yes| V
  E -->|no| F{At least 14 events}
  F -->|no| Z
  F -->|yes| N{Clearly stronger station within 300 Hz}
  N -->|no| G[Commit best guess as doubtful]
  N -->|yes| O[Hold the character back]
  H[Silence beyond 1.5 word gaps] --> I[Commit pending characters one by one while posterior at least 0.8]
  D --> J{First character of the track}
  G --> J
  J -->|no| K[Emit]
  J -->|yes| L{Silence before it at least a character gap, or its code ends no other code}
  L -->|yes| K
  L -->|no| W{Look-back reaches the stream start and silence before it}
  W -->|no| M[Drop as a possible cut-off tail]
  W -->|yes| X{It makes a callsign of the following token, which is none without it}
  X -->|yes| Y[Emit as doubtful]
  X -->|no| M
```

The Morse tree carries a character prior: at each node the next dit or dah, and continuing or ending the character, are weighted by tempered character frequencies, so that ambiguous gaps favour whole, likely characters.
On a track that a confirmed station at least 6 dB stronger within 300 Hz outshines, the prior is switched off, because there it turns spurious elements into confident characters, and doubtful characters are held back.
When that station is at least 10 dB stronger and within 70 Hz, a character is committed only at the full threshold of 0.99, and a character is held back and not learnt from when one of its element boundaries lies within two frames of the station's keying edges or when the space before it or within it holds such an edge, which may have erased a mark.
At the start of the stream, a first character after a short silence may be the tail of a character that was cut off; it is kept, as doubtful, only if it makes a callsign of the token that follows, which is none without it.

A keying edge of a strong station leaks into its neighbours, most strongly 40 to 60 Hz away (about 16 dB below its key-down level in the worst frame of a 40 ms window).
The decoder estimates this leakage per frame from the share of the key-down amplitude in the window and its change from the previous frame, and uses it in three places: a birth candidate that the leakage could explain is frozen instead of counted, the key-down likelihood of a weaker track is shrunk by one plus the leakage over its key-down power, and the key-state network sees the last clean frame while the leakage exceeds a tenth of that power.
The ramp column of each line is split into an in-phase part, which follows keying edges freely, and a quadrature part, which models a frequency error and is held near its slow average, so that the ramp no longer takes up a neighbour 25 to 50 Hz away whose beat rotates from frame to frame.
A new line is placed where it best explains the last four spectra together with the lines and ramps of nearby tracks, because its residual peak is pushed away from a strong neighbour.
A candidate whose onsets coincide with a stronger neighbour's edges is rejected as a ghost only if the coincidence clearly exceeds the chance rate given by the density of those edges, and never if it was key-down in at least ten frames, and a tenth of the frames, in which all its louder neighbours were silent.

## Tokens

Committed characters are never changed, but each closed token gets a verdict that tells whether it can be shown as confirmed.

```mermaid
flowchart TD
  A[Committed characters of a track] --> B[Cut at spaces and at the end of the track]
  B --> C{Whole token valid}
  C -->|no| D[Split off glued DE, TU, R, UR, CQ, TEST and 5NN if every part becomes valid]
  C -->|yes| E[Classify]
  D --> E
  E --> F{Callsign, exchange or procedure word}
  F -->|no| U[Doubtful: unknown or invalid]
  F -->|yes| G{First token after a dropped first character}
  G -->|yes| T[Doubtful: truncated]
  G -->|no| H{Callsign run together with a procedure word or a second callsign}
  H -->|yes| R[Doubtful: run together]
  H -->|no| I{Any doubtful character}
  I -->|no| K[Confirmed]
  I -->|yes| J{Same callsign read before on the track}
  J -->|yes| L[Confirmed: repeated]
  J -->|no| M[Doubtful: doubtful character]
```

A callsign has a prefix of one letter of the B F G I K M N R W series or two characters, one area digit and a suffix of one to four letters.
Japanese prefixes JA to JS take a suffix of two or three letters, 7K to 7N take area 1 to 4 and three letters, and JD takes area 1.
A prefix before a slash and a portable digit, P, M, MM, AM, A, QRP or country prefix after it are accepted.
An exchange is a report such as 5NN or 599, or a number with cut digits and at least one real digit, ended by at most one power letter P, L, M or H.
No callsign database is used.

## License

### Author

- JG1VPP
- JS2FVO

### Clauses

[MIT License](LICENSE)
