import type { HealthState, TopologySnapshot } from "../contracts/domain";

export interface RenderNodeView {
  id: string;
  markerId: number;
  label: string;
  type: string;
  health: HealthState;
  throughputMbps: number;
  latencyMs: number;
  packetLossPct: number;
  rssi: number | null;
  snr: number | null;
}

export interface RenderLinkView {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  medium: string;
  health: HealthState;
  utilizationPct: number;
  latencyMs: number;
  packetLossPct: number;
  beamColorHex: string;
  beamRadius: number;
  flowHz: number;
}

export interface RenderGraphView {
  nodes: RenderNodeView[];
  links: RenderLinkView[];
}

export function selectRenderGraphView(snapshot: TopologySnapshot): RenderGraphView {
  return {
    nodes: snapshot.nodes.map((node) => ({
      id: node.id,
      markerId: node.markerId,
      label: node.label,
      type: node.type,
      health: node.metrics.status,
      throughputMbps: node.metrics.throughputMbps ?? 0,
      latencyMs: node.metrics.latencyMs ?? 0,
      packetLossPct: node.metrics.packetLossPct ?? 0,
      rssi: node.metrics.rssi ?? null,
      snr: node.metrics.snr ?? null
    })),
    links: snapshot.links.map((link) => ({
      id: link.id,
      fromNodeId: link.fromNodeId,
      toNodeId: link.toNodeId,
      medium: link.medium,
      health: link.metrics.status,
      utilizationPct: link.metrics.utilizationPct ?? 0,
      latencyMs: link.metrics.latencyMs ?? 0,
      packetLossPct: link.metrics.packetLossPct ?? 0,
      beamColorHex: selectLinkColor(link.metrics.status),
      beamRadius: selectBeamRadius(link.medium),
      flowHz: selectFlowFrequency(link.metrics.utilizationPct ?? 0)
    }))
  };
}

function selectLinkColor(status: HealthState): string {
  if (status === "up") {
    return "#35d07f";
  }
  if (status === "degraded") {
    return "#ffd24d";
  }
  if (status === "down") {
    return "#ff5b5b";
  }
  return "#9fb4be";
}

function selectBeamRadius(medium: string): number {
  if (medium === "fiber") {
    return 0.032;
  }
  if (medium === "wired") {
    return 0.026;
  }
  if (medium === "wireless") {
    return 0.02;
  }
  return 0.018;
}

function selectFlowFrequency(utilizationPct: number): number {
  const clamped = Math.max(0, Math.min(utilizationPct, 100));
  // Keep flow legible: roughly one packet hop every ~2-6 seconds.
  return 0.16 + (clamped / 100) * 0.34;
}
