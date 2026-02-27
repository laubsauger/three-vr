/**
 * In-scene debug HUD rendered as a canvas-backed sprite.
 * Supports two modes:
 *   - "follow": locked to camera view (heads-up display)
 *   - "pinned": stays at its current world position
 */

import {
  Camera,
  CanvasTexture,
  Quaternion,
  Sprite,
  SpriteMaterial,
  Vector3,
} from "three";

export type HudMode = "follow" | "pinned";

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
  // Hand tracking
  handsDetected: number;
  leftPinch: boolean;
  rightPinch: boolean;
  leftPinchStrength: number;
  rightPinchStrength: number;
  hudMode: HudMode;
}

export class DebugHud {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: CanvasTexture;
  readonly sprite: Sprite;
  private lastData: DebugHudData | null = null;
  private lastUpdateMs = 0;
  private _mode: HudMode = "follow";

  /** Offset from camera in "follow" mode. */
  private readonly followOffset = new Vector3(-0.22, -0.10, -0.5);
  private readonly tmpPos = new Vector3();
  private readonly tmpQuat = new Quaternion();

  /** Minimum interval between texture redraws (ms). */
  private readonly updateIntervalMs = 120;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 340;
    this.canvas.height = 260;
    this.ctx = this.canvas.getContext("2d")!;

    this.texture = new CanvasTexture(this.canvas);
    const material = new SpriteMaterial({
      map: this.texture,
      transparent: true,
      depthTest: false,
    });
    this.sprite = new Sprite(material);
    this.sprite.name = "debug-hud";
    this.sprite.scale.set(0.34, 0.26, 1);

    this.drawEmpty();
  }

  get mode(): HudMode {
    return this._mode;
  }

  toggleMode(): HudMode {
    this._mode = this._mode === "follow" ? "pinned" : "follow";
    return this._mode;
  }

  setMode(mode: HudMode): void {
    this._mode = mode;
  }

  /**
   * Call every frame. Updates HUD content and position.
   */
  update(data: DebugHudData, timeMs: number, camera?: Camera): void {
    // Follow camera (use world quaternion so XR headset pose is included)
    if (this._mode === "follow" && camera) {
      camera.getWorldPosition(this.tmpPos);
      camera.getWorldQuaternion(this.tmpQuat);
      const forward = new Vector3(0, 0, -1).applyQuaternion(this.tmpQuat);
      const right = new Vector3(1, 0, 0).applyQuaternion(this.tmpQuat);
      const up = new Vector3(0, 1, 0).applyQuaternion(this.tmpQuat);

      this.sprite.position.copy(this.tmpPos)
        .add(forward.multiplyScalar(-this.followOffset.z))
        .add(right.multiplyScalar(this.followOffset.x))
        .add(up.multiplyScalar(this.followOffset.y));
    }

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
    ctx.clearRect(0, 0, 340, 260);
    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.beginPath();
    ctx.roundRect(4, 4, 332, 252, 8);
    ctx.fill();
    ctx.font = "14px monospace";
    ctx.fillStyle = "#557788";
    ctx.textAlign = "center";
    ctx.fillText("Waiting for data...", 170, 130);
    this.texture.needsUpdate = true;
  }

  private redraw(): void {
    const data = this.lastData;
    if (!data) return;

    const ctx = this.ctx;
    const w = 340;
    const h = 260;
    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = "rgba(6, 12, 16, 0.85)";
    ctx.beginPath();
    ctx.roundRect(4, 4, w - 8, h - 8, 8);
    ctx.fill();

    // Border color changes based on mode
    ctx.strokeStyle = this._mode === "pinned"
      ? "rgba(255, 200, 50, 0.4)"
      : "rgba(0, 255, 136, 0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(4, 4, w - 8, h - 8, 8);
    ctx.stroke();

    let y = 24;
    const lineH = 20;
    const left = 14;

    // Title + mode badge
    ctx.font = "bold 12px monospace";
    ctx.fillStyle = "#00ff88";
    ctx.textAlign = "left";
    ctx.fillText("DEBUG", left, y);

    // Mode badge
    ctx.font = "10px monospace";
    const modeLabel = this._mode === "follow" ? "FOLLOW" : "PINNED";
    const modeColor = this._mode === "follow" ? "#00ff88" : "#ffcc33";
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    const mw = ctx.measureText(modeLabel).width + 10;
    ctx.beginPath();
    ctx.roundRect(w - 14 - mw, y - 10, mw, 14, 3);
    ctx.fill();
    ctx.fillStyle = modeColor;
    ctx.textAlign = "right";
    ctx.fillText(modeLabel, w - 19, y);

    ctx.font = "10px monospace";
    ctx.fillStyle = "#557788";
    ctx.textAlign = "right";
    ctx.fillText(data.mode.toUpperCase(), w - 19 - mw - 8, y);

    y += lineH;

    // ---- Rows ----
    const row = (label: string, value: string, valueColor: string) => {
      ctx.textAlign = "left";
      ctx.font = "11px monospace";
      ctx.fillStyle = "#7799aa";
      ctx.fillText(label, left, y);
      ctx.textAlign = "right";
      ctx.fillStyle = valueColor;
      ctx.fillText(value, w - 14, y);
      y += lineH;
    };

    const fpsColor = data.fps >= 60 ? "#00ff88" : data.fps >= 30 ? "#ffcc33" : "#ff4444";
    row("FPS", data.fps.toFixed(1), fpsColor);
    row("Frame", `${data.avgFrameTimeMs.toFixed(1)}ms`, "#bbccdd");
    row("XR", data.xrState, data.xrState === "running" ? "#00ff88" : "#ffcc33");
    row("Tracking", `${data.trackingBackend} (${data.detectorStatus})`,
      data.detectorStatus === "ready" ? "#00ff88" : "#ffcc33");

    // Markers
    if (data.markerCount > 0) {
      row("Markers", `${data.markerCount} | best ID ${data.bestMarkerId ?? "?"} (${(data.bestConfidence * 100).toFixed(0)}%)`, "#00ff88");
    } else {
      row("Markers", "none", "#ff6644");
    }

    // ---- Separator ----
    ctx.strokeStyle = "rgba(85, 119, 136, 0.3)";
    ctx.beginPath();
    ctx.moveTo(left, y - 6);
    ctx.lineTo(w - 14, y - 6);
    ctx.stroke();
    y += 4;

    // ---- Hands section ----
    ctx.font = "bold 11px monospace";
    ctx.fillStyle = "#66aacc";
    ctx.textAlign = "left";
    ctx.fillText("HANDS", left, y);
    y += lineH;

    if (data.handsDetected > 0) {
      // Left hand
      const lPinchBar = renderBar(data.leftPinchStrength);
      const lColor = data.leftPinch ? "#00ffcc" : "#7799aa";
      row("L pinch", `${lPinchBar} ${data.leftPinch ? "ACTIVE" : ""}`, lColor);

      // Right hand
      const rPinchBar = renderBar(data.rightPinchStrength);
      const rColor = data.rightPinch ? "#00ffcc" : "#7799aa";
      row("R pinch", `${rPinchBar} ${data.rightPinch ? "ACTIVE" : ""}`, rColor);
    } else {
      ctx.font = "11px monospace";
      ctx.fillStyle = "#556677";
      ctx.textAlign = "left";
      ctx.fillText("No hands detected", left, y);
      y += lineH;
    }

    // Best marker highlight
    if (data.bestMarkerId != null && data.markerCount > 0) {
      y += 4;
      ctx.font = "bold 13px monospace";
      ctx.fillStyle = "#00ff88";
      ctx.textAlign = "center";
      ctx.fillText(`LOCKED: ID ${data.bestMarkerId}`, w / 2, y);
    }

    this.texture.needsUpdate = true;
  }
}

function renderBar(strength: number): string {
  const filled = Math.round(strength * 8);
  return "\u2588".repeat(filled) + "\u2591".repeat(8 - filled);
}
