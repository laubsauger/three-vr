import type { HealthState, TopologySnapshot } from "../contracts/domain";

export interface RenderNodeView {
  id: string;
  markerId: number;
  label: string;
  type: string;
  health: HealthState;
  throughputMbps: number;
}

export interface RenderLinkView {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  medium: string;
  health: HealthState;
  utilizationPct: number;
  beamColorHex: string;
  pulseHz: number;
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
      throughputMbps: node.metrics.throughputMbps ?? 0
    })),
    links: snapshot.links.map((link) => ({
      id: link.id,
      fromNodeId: link.fromNodeId,
      toNodeId: link.toNodeId,
      medium: link.medium,
      health: link.metrics.status,
      utilizationPct: link.metrics.utilizationPct ?? 0,
      beamColorHex: selectLinkColor(link.metrics.status),
      pulseHz: selectPulseFrequency(link.metrics.utilizationPct ?? 0)
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

function selectPulseFrequency(utilizationPct: number): number {
  const clamped = Math.max(0, Math.min(utilizationPct, 100));
  return 0.4 + (clamped / 100) * 2.4;
}
