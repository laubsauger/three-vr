# AGENTS.md

General instructions for all coding agents working in this repository.

## Mission
- Build a WebXR mixed-reality network visualization app targeting Meta Quest 3-class devices.
- Keep work parallelizable and integration-safe.
- Prefer small, testable, contract-driven increments.

## Core Principles
- Contract-first: update shared contracts before domain implementation.
- Clear ownership: one domain per agent branch.
- No surprise edits: do not modify files owned by another active agent unless it is an agreed integration task.
- Keep runtime stable: avoid risky refactors during active multi-agent development.

## Branching and Task Naming
- Branch pattern: `agent/<domain>/<short-task>`.
- Example: `agent/tracking/aruco-worker`.
- One active task per branch.

## Source Ownership Boundaries
- `src/contracts/*`: shared cross-domain API contracts only.
- `src/xr-core/*`: XR runtime, session lifecycle, capability checks.
- `src/tracking/*`: marker detection, pose filtering, confidence.
- `src/topology/*`: node/link graph store and coordinate transforms.
- `src/telemetry/*`: ingestion adapters, normalization, reconnect logic.
- `src/rendering/*`: scene primitives, materials, beam effects.
- `src/interaction/*`: hand/controller input, selection flows.
- `src/app/*`: composition and integration only.

## Required Workflow
1. Read `docs/idea.md` and current contracts before coding.
2. If your change affects other domains, update `src/contracts/*` first.
3. Implement in your owned directory.
4. Run `pnpm build` before handoff.
5. Document emitted/consumed events if integration behavior changes.

## Integration Contracts
- Use types from `src/contracts/index.ts`; do not redefine shared interfaces locally.
- Use app events from `src/contracts/events.ts`.
- Use `AppErrorEnvelope` for recoverable/non-recoverable runtime errors.

## Blocker Codes
- `BLOCKER-CONTRACT`: shared type/event contract missing or unresolved.
- `BLOCKER-PLATFORM`: required browser/WebXR feature missing or unstable.
- `BLOCKER-PERF`: performance below agreed threshold.
- `BLOCKER-DATA`: required telemetry fields unavailable.
- `BLOCKER-ASSET`: missing marker/visual assets needed for implementation.
- `BLOCKER-INTEGRATION`: incompatible API behavior or merge collision.

## Blocker Policy
- Blocked < 2 hours: self-resolve and post short note.
- Blocked >= 2 hours: report blocker code + minimal repro + impacted files.
- Contract/platform blockers pause dependent merges until resolved.
- Local blockers should not pause unrelated parallel streams.

## Code Quality Rules
- TypeScript strict mode must pass.
- Keep modules focused and small; avoid monolithic files.
- Add concise comments only where intent is non-obvious.
- Preserve existing behavior unless task explicitly changes behavior.
- Do not revert another agent’s changes unless explicitly requested.

## Validation Commands
- Install deps: `pnpm install`
- Dev server: `pnpm dev`
- Build check: `pnpm build`
- Preview prod build: `pnpm preview`

## Handoff Template
- Summary: what was implemented.
- Files: exact paths changed.
- Contracts: added/changed event/type names.
- Risks: known gaps, fallbacks, or TODOs.
- Blockers: active blocker code(s), if any.
