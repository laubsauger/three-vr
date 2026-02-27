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
  /** Base radius determined by medium type (used for geometry creation). */
  beamRadius: number;
  /** Traffic-scaled radius (base × utilization factor). */
  trafficRadius: number;
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
    links: snapshot.links.map((link) => {
      const baseRadius = selectBeamRadius(link.medium);
      const utilPct = link.metrics.utilizationPct ?? 0;
      return {
        id: link.id,
        fromNodeId: link.fromNodeId,
        toNodeId: link.toNodeId,
        medium: link.medium,
        health: link.metrics.status,
        utilizationPct: utilPct,
        latencyMs: link.metrics.latencyMs ?? 0,
        packetLossPct: link.metrics.packetLossPct ?? 0,
        beamColorHex: selectLinkColor(link.metrics.status),
        beamRadius: baseRadius,
        trafficRadius: selectTrafficRadius(baseRadius, utilPct),
        flowHz: selectFlowFrequency(utilPct),
      };
    })
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
    return 0.012;
  }
  if (medium === "wired") {
    return 0.009;
  }
  if (medium === "wireless") {
    return 0.007;
  }
  return 0.006;
}

function selectTrafficRadius(baseRadius: number, utilizationPct: number): number {
  const clamped = Math.max(0, Math.min(utilizationPct, 100));
  // 0.7× at idle → 1.6× at full load
  const factor = 0.7 + (clamped / 100) * 0.9;
  return baseRadius * factor;
}

function selectFlowFrequency(utilizationPct: number): number {
  const clamped = Math.max(0, Math.min(utilizationPct, 100));
  // Idle: 0.08 Hz (~12s per cycle), full: 0.8 Hz (~1.25s per cycle)
  return 0.08 + (clamped / 100) * 0.72;
}
