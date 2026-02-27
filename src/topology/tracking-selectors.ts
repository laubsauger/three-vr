import type { TopologySnapshot } from "../contracts/domain";

export interface TopologyStatsView {
  nodeCount: number;
  linkCount: number;
  degradedNodes: number;
  degradedLinks: number;
  downNodes: number;
  downLinks: number;
}

export function selectTopologyStats(snapshot: TopologySnapshot): TopologyStatsView {
  return {
    nodeCount: snapshot.nodes.length,
    linkCount: snapshot.links.length,
    degradedNodes: snapshot.nodes.filter((node) => node.metrics.status === "degraded").length,
    degradedLinks: snapshot.links.filter((link) => link.metrics.status === "degraded").length,
    downNodes: snapshot.nodes.filter((node) => node.metrics.status === "down").length,
    downLinks: snapshot.links.filter((link) => link.metrics.status === "down").length
  };
}
