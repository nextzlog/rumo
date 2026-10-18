#!/bin/sh
# Builds rumo.wasm (release, wasm32-unknown-unknown) and copies it to docs/.
# Requires the Rust target: rustup target add wasm32-unknown-unknown
set -eu
cd "$(dirname "$0")"
# Replace the local checkout path with a neutral prefix so that the binary is reproducible.
ROOT="$(cd .. && pwd)"
RUSTFLAGS="--remap-path-prefix=$ROOT=/rumo" cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/rumo_wasm.wasm ../docs/rumo.wasm
ls -l ../docs/rumo.wasm
