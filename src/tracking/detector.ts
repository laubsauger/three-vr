import type { MarkerDetector, RawMarkerDetection } from "./types";

/**
 * Mock detector that produces synthetic marker detections for testing.
 * Simulates 3 markers with slight positional jitter to exercise the
 * smoothing pipeline without requiring actual camera frames.
 */
export class MockMarkerDetector implements MarkerDetector {
  private readonly mockMarkers: Array<{
    markerId: number;
    baseX: number;
    baseY: number;
    baseZ: number;
    sizeMeters: number;
  }> = [
    { markerId: 101, baseX: 0, baseY: 1.3, baseZ: -1.5, sizeMeters: 0.15 },
    { markerId: 102, baseX: 1.2, baseY: 1.3, baseZ: -1.8, sizeMeters: 0.15 },
    { markerId: 103, baseX: -0.8, baseY: 1.5, baseZ: -1.2, sizeMeters: 0.10 },
  ];

  private frameCount = 0;

  detect(_frame: unknown, _referenceSpace: unknown): RawMarkerDetection[] {
    this.frameCount++;

    return this.mockMarkers
      .filter(() => {
        // Simulate intermittent detection (90% hit rate per marker)
        return Math.random() < 0.9;
      })
      .map((marker) => {
        // Add slight jitter to simulate noisy pose estimation
        const jitter = () => (Math.random() - 0.5) * 0.008;

        return {
          markerId: marker.markerId,
          pose: {
            position: {
              x: marker.baseX + jitter(),
              y: marker.baseY + jitter(),
              z: marker.baseZ + jitter(),
            },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            confidence: 0.7 + Math.random() * 0.3,
            lastSeenAtMs: performance.now(),
          },
          sizeMeters: marker.sizeMeters,
        };
      });
  }

  dispose(): void {
    // Nothing to clean up for mock
  }
}
