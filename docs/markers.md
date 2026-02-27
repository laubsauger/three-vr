# Marker Printing Guide (Local Parity Markers)

This project currently uses a local, vendored marker decoder (worker-based), not external ArUco npm packages.

## Print Markers
1. Open `docs/tools/parity-marker-generator.html` in a browser.
2. Generate IDs that match your topology marker IDs.
3. For current demo topology, print: `101`, `102`, `103`.
4. Print at high contrast (pure black/white), avoid glossy paper.

## Marker Format
- 6x6 grid.
- Outer border must be black.
- Inner 4x4 carries ID + parity bits.
- IDs range: `0..511`.

## Notes
- Decoder is tolerant to moderate noise but is not full ArUco dictionary decoding.
- Designed as an offline fallback path so no external package install is required.
- The tracking backend remains pluggable, so a full ArUco/WASM decoder can replace this later without app-wide refactors.
