/**
 * Floating canvas-backed sprite labels for infrastructure nodes and links.
 * Shows live-updating metrics: throughput, latency, utilization, health.
 */

import {
  CanvasTexture,
  Group,
  Sprite,
  SpriteMaterial,
  Vector3,
} from "three";

import type { RenderGraphView, RenderNodeView, RenderLinkView } from "../topology";
import type { HealthState } from "../contracts/domain";

interface LabelEntry {
  sprite: Sprite;
  canvas: HTMLCanvasElement;
  texture: CanvasTexture;
}

export class InfraLabelManager {
  private readonly root = new Group();
  private readonly nodeLabels = new Map<string, LabelEntry>();
  private readonly linkLabels = new Map<string, LabelEntry>();

  constructor() {
    this.root.name = "infra-labels";
  }

  getRoot(): Group {
    return this.root;
  }

  /**
   * Sync labels to the current graph. Redraws canvases and positions sprites.
   */
  updateGraph(
    graph: RenderGraphView,
    nodePositions: Map<string, Vector3>,
    linkMidpoints: Map<string, Vector3>,
  ): void {
    // ---- Node labels ----
    const nextNodeIds = new Set(graph.nodes.map((n) => n.id));
    for (const [id, entry] of this.nodeLabels) {
      if (!nextNodeIds.has(id)) {
        this.disposeEntry(entry);
        this.nodeLabels.delete(id);
      }
    }
    for (const node of graph.nodes) {
      let entry = this.nodeLabels.get(node.id);
      if (!entry) {
        entry = createEntry(256, 96, 0.18, 0.07);
        this.nodeLabels.set(node.id, entry);
        this.root.add(entry.sprite);
      }
      drawNodeLabel(entry, node);
      const pos = nodePositions.get(node.id);
      if (pos) {
        entry.sprite.position.set(pos.x, pos.y + 0.13, pos.z);
      }
    }

    // ---- Link labels ----
    const nextLinkIds = new Set(graph.links.map((l) => l.id));
    for (const [id, entry] of this.linkLabels) {
      if (!nextLinkIds.has(id)) {
        this.disposeEntry(entry);
        this.linkLabels.delete(id);
      }
    }
    for (const link of graph.links) {
      let entry = this.linkLabels.get(link.id);
      if (!entry) {
        entry = createEntry(256, 72, 0.15, 0.042);
        this.linkLabels.set(link.id, entry);
        this.root.add(entry.sprite);
      }
      drawLinkLabel(entry, link);
      const mid = linkMidpoints.get(link.id);
      if (mid) {
        entry.sprite.position.set(mid.x, mid.y + 0.06, mid.z);
      }
    }
  }

  dispose(): void {
    for (const entry of this.nodeLabels.values()) this.disposeEntry(entry);
    for (const entry of this.linkLabels.values()) this.disposeEntry(entry);
    this.nodeLabels.clear();
    this.linkLabels.clear();
    this.root.removeFromParent();
  }

  private disposeEntry(entry: LabelEntry): void {
    entry.texture.dispose();
    entry.sprite.material.dispose();
    this.root.remove(entry.sprite);
  }
}

// ---- Factories ----

function createEntry(w: number, h: number, sx: number, sy: number): LabelEntry {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const texture = new CanvasTexture(canvas);
  const material = new SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
  });
  const sprite = new Sprite(material);
  sprite.scale.set(sx, sy, 1);
  return { sprite, canvas, texture };
}

// ---- Drawing ----

function drawNodeLabel(entry: LabelEntry, node: RenderNodeView): void {
  const ctx = entry.canvas.getContext("2d")!;
  const w = entry.canvas.width;
  const h = entry.canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Background
  ctx.fillStyle = "rgba(6, 12, 16, 0.82)";
  ctx.beginPath();
  ctx.roundRect(2, 2, w - 4, h - 4, 6);
  ctx.fill();

  // Border tinted by health
  ctx.strokeStyle = healthColor(node.health, 0.5);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(2, 2, w - 4, h - 4, 6);
  ctx.stroke();

  // Health dot
  ctx.fillStyle = healthColor(node.health, 1);
  ctx.beginPath();
  ctx.arc(16, 22, 5, 0, Math.PI * 2);
  ctx.fill();

  // Name
  ctx.font = "bold 18px monospace";
  ctx.fillStyle = "#ddeeff";
  ctx.textAlign = "left";
  ctx.fillText(truncate(node.label, 16), 28, 26);

  // Type badge
  ctx.font = "12px monospace";
  ctx.fillStyle = "#667788";
  ctx.textAlign = "right";
  ctx.fillText(node.type, w - 8, 26);

  // Metrics row
  ctx.textAlign = "left";
  ctx.font = "14px monospace";

  // Throughput
  ctx.fillStyle = "#77ccaa";
  ctx.fillText(`${node.throughputMbps.toFixed(0)} Mbps`, 8, 52);

  // Latency
  const latColor = node.latencyMs > 80 ? "#ff6644" : node.latencyMs > 40 ? "#ffcc33" : "#8899aa";
  ctx.fillStyle = latColor;
  ctx.fillText(`${node.latencyMs.toFixed(0)}ms`, 130, 52);

  // Packet loss (only show if notable)
  if (node.packetLossPct > 0.5) {
    const lossColor = node.packetLossPct > 3 ? "#ff6644" : "#ffcc33";
    ctx.fillStyle = lossColor;
    ctx.fillText(`${node.packetLossPct.toFixed(1)}% loss`, 8, 74);
  }

  // RSSI if available
  if (node.rssi != null) {
    ctx.fillStyle = node.rssi > -50 ? "#77ccaa" : node.rssi > -70 ? "#ffcc33" : "#ff6644";
    ctx.fillText(`${node.rssi}dBm`, 130, 74);
  }

  entry.texture.needsUpdate = true;
}

function drawLinkLabel(entry: LabelEntry, link: RenderLinkView): void {
  const ctx = entry.canvas.getContext("2d")!;
  const w = entry.canvas.width;
  const h = entry.canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Background
  ctx.fillStyle = "rgba(6, 12, 16, 0.78)";
  ctx.beginPath();
  ctx.roundRect(2, 2, w - 4, h - 4, 6);
  ctx.fill();

  ctx.strokeStyle = healthColor(link.health, 0.4);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(2, 2, w - 4, h - 4, 6);
  ctx.stroke();

  // Health dot
  ctx.fillStyle = healthColor(link.health, 1);
  ctx.beginPath();
  ctx.arc(14, 18, 4, 0, Math.PI * 2);
  ctx.fill();

  // Medium
  ctx.font = "bold 15px monospace";
  ctx.fillStyle = "#ddeeff";
  ctx.textAlign = "left";
  ctx.fillText(link.medium, 24, 22);

  // Utilization bar
  const utilColor = link.utilizationPct > 80 ? "#ff6644" : link.utilizationPct > 50 ? "#ffcc33" : "#77ccaa";
  ctx.fillStyle = utilColor;
  ctx.font = "13px monospace";
  ctx.fillText(`${link.utilizationPct.toFixed(0)}%`, 120, 22);

  // Utilization mini-bar
  const barX = 155;
  const barW = 90;
  const barH = 6;
  const barY = 15;
  ctx.fillStyle = "rgba(255,255,255,0.1)";
  ctx.fillRect(barX, barY, barW, barH);
  ctx.fillStyle = utilColor;
  ctx.fillRect(barX, barY, barW * Math.min(link.utilizationPct / 100, 1), barH);

  // Second row: latency + loss
  ctx.font = "13px monospace";
  const latColor = link.latencyMs > 80 ? "#ff6644" : link.latencyMs > 40 ? "#ffcc33" : "#8899aa";
  ctx.fillStyle = latColor;
  ctx.fillText(`${link.latencyMs.toFixed(0)}ms`, 8, 50);

  if (link.packetLossPct > 0.5) {
    const lossColor = link.packetLossPct > 3 ? "#ff6644" : "#ffcc33";
    ctx.fillStyle = lossColor;
    ctx.fillText(`${link.packetLossPct.toFixed(1)}% loss`, 80, 50);
  }

  entry.texture.needsUpdate = true;
}

// ---- Helpers ----

function healthColor(health: HealthState, alpha: number): string {
  if (health === "up") return `rgba(62, 213, 138, ${alpha})`;
  if (health === "degraded") return `rgba(255, 207, 82, ${alpha})`;
  if (health === "down") return `rgba(255, 100, 100, ${alpha})`;
  return `rgba(142, 167, 178, ${alpha})`;
}

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 1) + "\u2026" : text;
}
