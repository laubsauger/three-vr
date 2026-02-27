# WebXR IT Infrastructure Visualizer

## Vision
Build a mixed-reality network operations experience that runs in modern browsers on Meta Quest 3 (and similar devices), using Three.js + WebXR. The user looks at physical infrastructure markers and sees live 3D overlays for topology, signal quality, throughput, and link status.

## Product Goals
- Make invisible network behavior visible in space.
- Show physical-to-logical mapping (tower -> home -> router -> device).
- Support field diagnostics with fast scanning and low interaction friction.
- Start with a demo that proves marker-based anchoring + animated link rendering.

## First Demo Scope (MVP)
- Detect printed ArUco markers posted on walls/devices/paper.
- Resolve marker IDs to infrastructure nodes from a local dataset.
- Render anchored node cards (name, type, status, RSSI/SNR/latency/throughput).
- Draw animated 3D beams between nodes (wired and wireless styles).
- Color links by health (green/yellow/red), pulse speed by traffic load.

## Target Platform and Standards
- Runtime: Quest Browser on Meta Quest 3 (primary), other WebXR-capable headsets (secondary).
- Rendering: Three.js + WebXR renderer path.
- Language/build: TypeScript + Vite.
- Data transport: JSON over WebSocket (live) with REST fallback (snapshot).
- Scene assets: glTF 2.0.
- Browser APIs: WebXR Device API, Hit Test, Anchors (when available), DOM Overlay (optional), Web Workers.

## Reference Notes from `dmvrg/webxr-ar-demos`
- Keep each experience modular (`XR setup`, `hand input`, `domain logic`, `UI module`).
- Prefer small, focused files per subsystem instead of one monolithic `main`.
- Use interaction-first design patterns (pinch, ray interactions, in-world UI).
- Maintain a simple "demo-first" structure so each milestone is runnable quickly.

## Proposed Architecture
1. `xr-core`
   - Session init, reference space, frame loop, feature flags.
2. `tracking`
   - Camera frame pipeline + ArUco detection + pose smoothing.
3. `topology`
   - Node/link model, coordinate transforms, cache, subscription updates.
4. `rendering`
   - Node meshes, billboard UI, animated beams, effects.
5. `interaction`
   - Hand/controller ray, node focus, detail panel toggles.
6. `telemetry`
   - Ingestion adapter for mocked/live network metrics.

## Data Model (Initial)
```json
{
  "nodes": [
    {
      "id": "tower-1",
      "markerId": 101,
      "type": "tower",
      "label": "Town Tower",
      "metrics": { "status": "up", "rssi": -52, "snr": 31, "throughputMbps": 420 }
    }
  ],
  "links": [
    {
      "id": "link-1",
      "from": "tower-1",
      "to": "house-12",
      "medium": "wireless",
      "metrics": { "status": "degraded", "latencyMs": 38, "packetLossPct": 1.8, "utilizationPct": 74 }
    }
  ]
}
```

## Spatial Mapping Strategy
- Use local XR coordinates for room-scale rendering and interaction.
- Store global position for known assets (tower, buildings, poles) in lat/lon/alt.
- Convert global coordinates to local ENU coordinates around a chosen origin.
- Blend marker-derived local anchors with geospatial transforms for city-to-room continuity.

## Delivery Plan

### Phase 0: Foundation (1 week)
- Create TypeScript + Vite + Three.js WebXR app skeleton.
- Add Quest-safe performance baseline (72 FPS target, dynamic quality toggle).
- Add module structure matching the architecture above.

### Phase 1: Marker Anchoring Demo (1-2 weeks)
- Integrate ArUco detection pipeline.
- Map marker IDs to mocked nodes.
- Render anchored node indicators and stable pose smoothing.
- Exit criteria: 3+ markers tracked in one session with usable stability.

### Phase 2: Topology + Beam Visualization (1 week)
- Load node/link graph from local JSON.
- Draw curves/tubes between anchors.
- Add animated flow + health color system.
- Exit criteria: Live update of colors/pulse when metrics change.

### Phase 3: Telemetry Ingestion (1 week)
- Add WebSocket ingestion adapter + reconnect logic.
- Normalize incoming metrics into app model.
- Add timestamped stale-data handling.
- Exit criteria: Dashboard reacts to streamed updates in near real-time.

### Phase 4: Interaction + Analytics UX (1 week)
- Node/link selection via hands/controllers.
- Open detail cards with trend snippets and troubleshooting hints.
- Add filtering modes (signal, latency, packet loss, offline only).
- Exit criteria: Operator can isolate bad links in under 30 seconds.

### Phase 5: Town-Scale Overlay (optional after MVP)
- Ingest GIS/network inventory (tower -> neighborhoods -> homes).
- Render long-distance wireless beams and relay hops.
- Add scale mode toggle (room view vs area network view).
- Exit criteria: User can trace one endpoint from local router to upstream tower path.

## Performance and Reliability Targets
- Motion-to-photon smoothness: stable user comfort at Quest refresh rates.
- Scene budget: cap active draw calls and beam segment counts.
- Tracking robustness: pose filtering with confidence thresholds.
- Failure behavior: degrade gracefully if marker tracking drops.

## Risks and Mitigations
- Marker occlusion/lighting variability.
  - Mitigation: confidence gating, smoothing, re-acquire prompts.
- WebXR feature fragmentation across browsers/devices.
  - Mitigation: capability checks and fallback feature flags.
- Large topology performance costs.
  - Mitigation: LOD, culling, clustering, selective rendering by proximity/filter.

## Demo Storyboard (First Operator Walkthrough)
1. User starts session in Quest 3 passthrough mode.
2. User scans printed marker on tower board, then home/router markers.
3. Node cards appear anchored in space.
4. Beams connect topology; one beam turns yellow/red as metrics degrade.
5. User selects the degraded link and reads latency/loss details.

## Immediate Next Tasks
1. Confirm marker library choice (`js-aruco` vs alternative with Quest browser compatibility).
2. Build `phase-0` skeleton with XR session bootstrap + FPS instrumentation.
3. Create mocked telemetry feed and sample topology for first demo.

## Multi-Agent Execution Model

### Branch and Ownership Rules
- One agent per domain branch: `agent/<domain>/<short-task>`.
- No shared-file edits unless a task is marked as integration.
- Each agent owns a stable directory boundary to reduce merge conflicts.
- Cross-domain contracts are finalized first (types, events, payload shape).

### Repository Segmentation (for parallel work)
- `src/xr-core/*`: XR session lifecycle, frame loop, capability checks.
- `src/tracking/*`: ArUco detection, pose estimation, smoothing pipeline.
- `src/topology/*`: Node/link graph model, coordinate transforms, store.
- `src/rendering/*`: Node visuals, beam rendering, materials, shaders.
- `src/interaction/*`: Hand/controller input, raycast, selection UX.
- `src/telemetry/*`: WebSocket adapter, REST bootstrap, normalization.
- `src/contracts/*`: Shared TypeScript interfaces and event definitions.
- `src/app/*`: Composition root and feature wiring only.

### Parallel Workstreams
1. Agent A: XR Core
- Deliver WebXR bootstrap, session state machine, reference spaces.
- Output: `XrRuntime` API consumed by other domains.
2. Agent B: Tracking
- Deliver ArUco detector wrapper + pose smoothing + confidence scoring.
- Output: `TrackedMarker[]` stream with stable transforms.
3. Agent C: Topology + Telemetry
- Deliver graph store and live metric update pipeline.
- Output: typed selectors (`getNode`, `getLinks`, `subscribeMetrics`).
4. Agent D: Rendering
- Deliver node billboards and animated beam renderer.
- Output: render primitives fed by topology + tracking data.
5. Agent E: Interaction + UX
- Deliver target selection, focus state, and detail panels.
- Output: input events and selection state integrated with renderer.
6. Agent F: QA/Perf Harness
- Deliver FPS/frametime counters, synthetic load scenes, regression checks.
- Output: repeatable performance report for Quest browser.

### Blocker Definitions
- `BLOCKER-CONTRACT`: Shared type/event contract not finalized.
- `BLOCKER-PLATFORM`: Required WebXR/browser feature missing or unstable.
- `BLOCKER-PERF`: FPS below target under agreed scene complexity.
- `BLOCKER-DATA`: Missing telemetry fields required for UX/state logic.
- `BLOCKER-ASSET`: Required marker set, icons, or 3D assets unavailable.
- `BLOCKER-INTEGRATION`: Merge conflict or incompatible API behavior.

### Dependency Order (what must happen first)
1. `contracts` baseline (unblocks all streams).
2. `xr-core` scaffold + telemetry mock server (unblocks integration tests).
3. tracking/topology/rendering/interaction in parallel.
4. composition and integration pass in `src/app`.
5. perf hardening and Quest validation pass.

### Integration Cadence
- Daily contract check-in (15 min): only shared types/events.
- Integration windows twice per day:
  - Window 1: `xr-core + tracking + rendering`.
  - Window 2: `topology + telemetry + interaction`.
- One integration owner rotates daily to resolve conflicts fast.

### Definition of Done per Task
- Code builds and passes domain tests.
- No contract drift from `src/contracts`.
- Includes minimal observability logs for failure states.
- Includes Quest browser verification notes (or explicit gap).
- PR includes rollback plan if feature flag is disabled.

### Sprint 1 Task List (Parallel-Ready)
1. Contracts
- Define `Node`, `Link`, `MetricSnapshot`, `TrackedMarker`, `AnchorPose`.
- Define app event bus payloads and error envelope format.
2. XR Core
- Implement session bootstrap with capability flags (`anchors`, `hit-test`).
- Expose frame tick and reference space accessors.
3. Tracking
- Add ArUco detection worker and frame throttling strategy.
- Emit smoothed marker pose stream with confidence field.
4. Topology/Telemetry
- Load mocked topology JSON and stream metric deltas via WebSocket mock.
- Normalize and patch graph store atomically.
5. Rendering
- Draw anchored node cards and link beams with health color mapping.
- Add traffic pulse animation parameterized by utilization.
6. Interaction
- Implement ray/pinch selection and node detail card toggles.
- Add filters: degraded links, high latency, offline nodes.
7. QA/Perf
- Add stress scene with 100 nodes / 200 links.
- Record baseline FPS and frame time percentile in Quest browser.

### Initial Blocker Policy
- If blocked < 2 hours: agent self-resolves and posts note in task thread.
- If blocked >= 2 hours: raise blocker code + minimal repro.
- If blocker affects contract/platform: freeze dependent merges until resolved.
- If blocker is local-only: continue other parallel tasks, do not stall sprint.
