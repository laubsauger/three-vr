export interface PerformanceSnapshot {
  fps: number;
  avgFrameTimeMs: number;
  p95FrameTimeMs: number;
  sampleSize: number;
}

interface FrameSample {
  timeMs: number;
  deltaMs: number;
}

export class PerformanceMonitor {
  private readonly windowMs: number;
  private readonly samples: FrameSample[] = [];

  constructor(windowMs = 2000) {
    this.windowMs = windowMs;
  }

  recordFrame(timeMs: number, deltaMs: number): void {
    this.samples.push({
      timeMs,
      deltaMs
    });
    this.trim(timeMs);
  }

  getSnapshot(nowMs: number): PerformanceSnapshot {
    this.trim(nowMs);
    const sampleSize = this.samples.length;

    if (sampleSize === 0) {
      return {
        fps: 0,
        avgFrameTimeMs: 0,
        p95FrameTimeMs: 0,
        sampleSize: 0
      };
    }

    const totalFrameTimeMs = this.samples.reduce((acc, sample) => acc + sample.deltaMs, 0);
    const avgFrameTimeMs = totalFrameTimeMs / sampleSize;
    const fps = avgFrameTimeMs > 0 ? 1000 / avgFrameTimeMs : 0;

    const sortedFrameTimes = this.samples.map((sample) => sample.deltaMs).sort((a, b) => a - b);
    const p95Index = Math.min(sortedFrameTimes.length - 1, Math.floor(sortedFrameTimes.length * 0.95));
    const p95FrameTimeMs = sortedFrameTimes[p95Index];

    return {
      fps,
      avgFrameTimeMs,
      p95FrameTimeMs,
      sampleSize
    };
  }

  private trim(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    while (this.samples.length > 0 && this.samples[0].timeMs < cutoff) {
      this.samples.shift();
    }
  }
}
