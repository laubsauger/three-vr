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

- **`contracts/`** — Shared TypeScript types and interfaces. All domain modules import from here. Types defined here are the cross-domain API contract.
- **`xr-core/`** — WebXR session lifecycle, capability detection, frame loop, reference space resolution. Exports `XrRuntime` class which is the main entry point for XR functionality.
- **`app/`** — Composition root. `bootstrap.ts` wires together the scene, renderer, UI, and XR runtime. This is the only module that imports from multiple domains.
- **`main.ts`** — Entry point, calls `bootstrapApp()`.

### Planned domain modules (from `docs/idea.md`)

The architecture is designed for parallel development with strict directory ownership:

- `tracking/` — ArUco marker detection, pose smoothing, confidence scoring
- `topology/` — Node/link graph model, coordinate transforms, subscription store
- `rendering/` — Node meshes, billboard UI, animated beam effects
- `interaction/` — Hand/controller input, raycast, selection UX
- `telemetry/` — WebSocket adapter, REST bootstrap, metric normalization

### Key patterns

- **State machine:** `XrRuntime` uses a state machine (`idle → requesting → running → ending → idle`, or `→ failed`). Check `XrRuntimeState` type in `contracts/xr.ts`.
- **Frame subscriptions:** External code subscribes to XR frame ticks via `xrRuntime.subscribeFrame()`, which provides time, delta, XRFrame, and reference space.
- **Capability detection:** `detectCapabilities()` probes WebXR API support before session start. Results are cached.
- **Reference space fallback:** Tries `local-floor → local → viewer` in order when establishing XR sessions.
- **Dual render loops:** Desktop uses `requestAnimationFrame`; XR mode uses Three.js `setAnimationLoop` (which delegates to the XR session's RAF).

## TypeScript

Strict mode enabled with `noUnusedLocals` and `noUnusedParameters`. Target ES2022, module ESNext with Bundler resolution.
