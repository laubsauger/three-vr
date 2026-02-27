/**
 * In-scene debug HUD rendered as a canvas-backed sprite.
 * Floats in front of the camera so it's visible in XR.
 */

import {
  CanvasTexture,
  Sprite,
  SpriteMaterial,
} from "three";

export interface DebugHudData {
  fps: number;
  avgFrameTimeMs: number;
  mode: "xr" | "desktop";
  markerCount: number;
  bestMarkerId: number | null;
  bestConfidence: number;
  trackingBackend: string;
  detectorStatus: string;
  xrState: string;
}

export class DebugHud {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: CanvasTexture;
  readonly sprite: Sprite;
  private lastData: DebugHudData | null = null;
  private lastUpdateMs = 0;

  /** Minimum interval between texture redraws (ms). */
  private readonly updateIntervalMs = 150;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 320;
    this.canvas.height = 200;
    this.ctx = this.canvas.getContext("2d")!;

    this.texture = new CanvasTexture(this.canvas);
    const material = new SpriteMaterial({
      map: this.texture,
      transparent: true,
      depthTest: false,
    });
    this.sprite = new Sprite(material);
    this.sprite.name = "debug-hud";
    // Default scale for XR; caller can adjust
    this.sprite.scale.set(0.32, 0.2, 1);

    this.drawEmpty();
  }

  update(data: DebugHudData, timeMs: number): void {
    if (timeMs - this.lastUpdateMs < this.updateIntervalMs) return;
    this.lastUpdateMs = timeMs;
    this.lastData = data;
    this.redraw();
  }

  dispose(): void {
    this.texture.dispose();
    this.sprite.material.dispose();
  }

  private drawEmpty(): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, 320, 200);
    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.beginPath();
    ctx.roundRect(4, 4, 312, 192, 8);
    ctx.fill();
    ctx.font = "14px monospace";
    ctx.fillStyle = "#557788";
    ctx.textAlign = "center";
    ctx.fillText("Waiting for data...", 160, 100);
    this.texture.needsUpdate = true;
  }

  private redraw(): void {
    const data = this.lastData;
    if (!data) return;

    const ctx = this.ctx;
    const w = 320;
    const h = 200;
    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = "rgba(6, 12, 16, 0.82)";
    ctx.beginPath();
    ctx.roundRect(4, 4, w - 8, h - 8, 8);
    ctx.fill();

    // Border
    ctx.strokeStyle = "rgba(0, 255, 136, 0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(4, 4, w - 8, h - 8, 8);
    ctx.stroke();

    let y = 26;
    const lineH = 22;
    const left = 16;

    // Title
    ctx.font = "bold 13px monospace";
    ctx.fillStyle = "#00ff88";
    ctx.textAlign = "left";
    ctx.fillText("DEBUG", left, y);
    ctx.font = "11px monospace";
    ctx.fillStyle = "#557788";
    ctx.textAlign = "right";
    ctx.fillText(data.mode.toUpperCase(), w - 16, y);

    y += lineH;

    // FPS
    ctx.textAlign = "left";
    ctx.font = "12px monospace";
    ctx.fillStyle = "#8899aa";
    ctx.fillText("FPS", left, y);
    ctx.textAlign = "right";
    const fpsColor = data.fps >= 60 ? "#00ff88" : data.fps >= 30 ? "#ffcc33" : "#ff4444";
    ctx.fillStyle = fpsColor;
    ctx.fillText(`${data.fps.toFixed(1)}`, w - 16, y);

    y += lineH;

    // Frame time
    ctx.textAlign = "left";
    ctx.fillStyle = "#8899aa";
    ctx.fillText("Frame", left, y);
    ctx.textAlign = "right";
    ctx.fillStyle = "#bbccdd";
    ctx.fillText(`${data.avgFrameTimeMs.toFixed(1)}ms`, w - 16, y);

    y += lineH;

    // XR state
    ctx.textAlign = "left";
    ctx.fillStyle = "#8899aa";
    ctx.fillText("XR", left, y);
    ctx.textAlign = "right";
    ctx.fillStyle = data.xrState === "running" ? "#00ff88" : "#ffcc33";
    ctx.fillText(data.xrState, w - 16, y);

    y += lineH;

    // Tracking
    ctx.textAlign = "left";
    ctx.fillStyle = "#8899aa";
    ctx.fillText("Tracking", left, y);
    ctx.textAlign = "right";
    ctx.fillStyle = data.detectorStatus === "ready" ? "#00ff88" : "#ffcc33";
    ctx.fillText(`${data.trackingBackend} (${data.detectorStatus})`, w - 16, y);

    y += lineH;

    // Markers
    ctx.textAlign = "left";
    ctx.fillStyle = "#8899aa";
    ctx.fillText("Markers", left, y);
    ctx.textAlign = "right";
    if (data.markerCount > 0) {
      ctx.fillStyle = "#00ff88";
      ctx.fillText(
        `${data.markerCount} | best ID ${data.bestMarkerId ?? "?"} (${(data.bestConfidence * 100).toFixed(0)}%)`,
        w - 16, y,
      );
    } else {
      ctx.fillStyle = "#ff6644";
      ctx.fillText("none", w - 16, y);
    }

    y += lineH + 2;

    // Separator
    ctx.strokeStyle = "rgba(85, 119, 136, 0.3)";
    ctx.beginPath();
    ctx.moveTo(left, y - 8);
    ctx.lineTo(w - 16, y - 8);
    ctx.stroke();

    // Best marker highlight
    if (data.bestMarkerId != null && data.markerCount > 0) {
      ctx.font = "bold 14px monospace";
      ctx.fillStyle = "#00ff88";
      ctx.textAlign = "center";
      ctx.fillText(`LOCKED: ID ${data.bestMarkerId}`, w / 2, y + 4);
    }

    this.texture.needsUpdate = true;
  }
}
