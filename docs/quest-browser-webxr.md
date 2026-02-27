# Quest Browser WebXR Support — Verified Facts (Feb 2026)

Research date: 2026-02-27. Horizon OS v85, Quest Browser ~Chromium 142-144.

## Camera Access

**`camera-access` WebXR feature: NOT SUPPORTED.**
Requesting it returns: `"Feature 'camera-access' is not supported for mode: immersive-ar"` (confirmed on v85).

Meta announced WebXR camera access for Horizon OS v77 (April 2025) but it never shipped through v85.

**`getUserMedia()`: WORKS outside XR sessions.**
Quest 3 exposes 3 cameras via `enumerateDevices()`: front selfie cam, left passthrough cam, right passthrough cam.
Using `facingMode: "environment"` targets the passthrough cameras. Resolution: up to 1280x960 native (1280x1280 in v83+).

**During active immersive-ar session**: getUserMedia may fail with `NotReadable` — the UA can claim exclusive camera access. Behavior is device-dependent and unreliable.

**Strategy**: Acquire camera stream via getUserMedia *before* entering XR. Run ArUco detection on that stream. Accept that frames are not pose-synchronized with XR — use smoothing to compensate.

## WebXR Feature Support Table

| Feature | Status | Notes |
|---------|--------|-------|
| `hit-test` | SUPPORTED | Uses Depth API since Browser v40.4 |
| `anchors` | SUPPORTED | Max 8 persistent anchors per site |
| `plane-detection` | SUPPORTED | Horizontal/vertical rectangles |
| `mesh-detection` | SUPPORTED | Scene mesh on Quest 3/3S |
| `depth-sensing` | SUPPORTED | Real-time stereo depth frames |
| `hand-tracking` | SUPPORTED | 25 joints per hand |
| `body-tracking` | SUPPORTED | Since Browser v40.0 |
| `dom-overlay` | NOT SUPPORTED | Explicitly rejected |
| `camera-access` | NOT SUPPORTED | Explicitly rejected |
| `image-tracking` | NOT SUPPORTED | Still behind Chromium flag, never shipped |

## Implications for Marker Detection

Since neither `camera-access` nor `image-tracking` is available:

1. Use `getUserMedia()` to get camera frames (works pre-XR session, unreliable during)
2. Run ArUco detection using js-aruco2 in a Web Worker
3. Map detected 2D marker positions to approximate 3D positions
4. No camera intrinsics available — positions are approximate
5. Use pose smoothing to reduce jitter from non-synchronized frames

## Sources

- Meta Community Forums: camera-access rejection on v85
- Meta Developer Docs: webxr-mixed-reality
- Meta Browser Release Notes: Browser v40 features
- WebXR Raw Camera Access Module spec (Dec 2025 draft)
- Meta Passthrough Camera API blog post
