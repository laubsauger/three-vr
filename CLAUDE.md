# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- **Dev server:** `pnpm dev` (Vite on port 5173)
- **Build:** `pnpm build` (runs `tsc --noEmit` then `vite build`)
- **Preview prod build:** `pnpm preview`
- No test runner or linter is configured yet.

## Architecture

WebXR mixed-reality app for visualizing IT infrastructure in AR, targeting Meta Quest 3 via Quest Browser. Built with Three.js + WebXR + TypeScript + Vite.

### Source layout (`src/`)

- **`contracts/`** — Shared TypeScript types/interfaces. Cross-domain API contract. All domain modules import from here.
- **`xr-core/`** — WebXR session lifecycle, capability detection, frame loop, reference space. Exports `XrRuntime`.
- **`tracking/`** — ArUco marker detection via js-aruco2 in a Web Worker. Pose smoothing (exponential lerp/slerp). Camera capture via `getUserMedia`. `MarkerDetector` interface for pluggable backends.
- **`topology/`** — Node/link graph model, coordinate transforms, selectors for rendering.
- **`rendering/`** — `InfraSceneRenderer` (node spheres, beam links, health colors). `KmlMapRenderer` (3D map overlay anchored to detected markers).
- **`interaction/`** — Hand/controller input, raycast, node/link selection.
- **`telemetry/`** — Mock metric stream, WebSocket adapter placeholder.
- **`kml/`** — KML parser (UISP Design Center format), geo-to-local projection, 3D map renderer.
- **`app/`** — Composition root. `bootstrap.ts` wires everything. `agent-suite.ts` creates all domain agents. `event-bus.ts` is the typed pub/sub.
- **`main.ts`** — Entry point, calls `bootstrapApp()`.

### Key patterns

- **Agent pattern:** Each domain implements a `TrackingAgent`/`TopologyAgent`/etc. interface with `init(context)` + `dispose()`. The `IntegrationCoordinator` initializes them in order and disposes in reverse.
- **Event bus:** Typed `AppEventBus` with `emit()`/`on()`. Events: `xr/frame`, `tracking/markers`, `topology/snapshot`, `telemetry/update`, `interaction/selection-change`, `app/error`, `app/performance`.
- **State machine:** `XrRuntime` uses `idle → requesting → running → ending → idle` (or `→ failed`).
- **Dual render loops:** Desktop uses `requestAnimationFrame`; XR uses Three.js `setAnimationLoop`.
- **Worker-based detection:** `marker-worker.ts` runs js-aruco2 ArUco detection off the main thread. Uses `?raw` Vite imports to load the CJS library via `Function.call()`.
- **KML map overlay:** The Bombay Beach KML (`docs/bombay-beach-feb-27-2026.kml`) is loaded via `?raw` import. Parsed at boot, rendered as a miniature 3D map anchored to the first detected ArUco marker.

### Quest Browser constraints (see `docs/quest-browser-webxr.md`)

- `camera-access` WebXR feature: NOT supported (as of Horizon OS v85, Feb 2026)
- `dom-overlay`: NOT supported
- `image-tracking`: NOT supported
- Camera frames: obtained via `getUserMedia()` before XR session (unreliable during)
- Supported: `hit-test`, `anchors`, `plane-detection`, `hand-tracking`, `depth-sensing`, `mesh-detection`, `body-tracking`

## TypeScript

Strict mode with `noUnusedLocals` and `noUnusedParameters`. Target ES2022, module ESNext, Bundler resolution.

## Dependencies

- `three` — 3D rendering + WebXR
- `js-aruco2` — ArUco marker detection (ARUCO_4X4_1000 dictionary, loaded via `?raw` in worker)
