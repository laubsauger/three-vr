import type { RenderGraphView, RenderLinkView, RenderNodeView } from "./rendering-selectors";

export type TopologyFilterMode =
  | "all"
  | "degraded"
  | "down"
  | "high-latency"
  | "high-loss";

export interface TopologyFilterResult {
  graph: RenderGraphView;
  filteredNodeCount: number;
  filteredLinkCount: number;
  totalNodeCount: number;
  totalLinkCount: number;
}

const HIGH_LATENCY_THRESHOLD_MS = 40;
const HIGH_LOSS_THRESHOLD_PCT = 1.5;

export function applyTopologyFilter(
  graph: RenderGraphView,
  mode: TopologyFilterMode
): TopologyFilterResult {
  if (mode === "all") {
    return {
      graph,
      filteredNodeCount: graph.nodes.length,
      filteredLinkCount: graph.links.length,
      totalNodeCount: graph.nodes.length,
      totalLinkCount: graph.links.length,
    };
  }

  const matchedNodeIds = new Set<string>();
  const nodes: RenderNodeView[] = [];
  const links: RenderLinkView[] = [];

  for (const node of graph.nodes) {
    if (matchesNodeFilter(node, mode)) {
      matchedNodeIds.add(node.id);
      nodes.push(node);
    }
  }

  for (const link of graph.links) {
    if (matchesLinkFilter(link, mode)) {
      links.push(link);
      // Include connected nodes that weren't already matched
      if (!matchedNodeIds.has(link.fromNodeId)) {
        const fromNode = graph.nodes.find((n) => n.id === link.fromNodeId);
        if (fromNode) {
          matchedNodeIds.add(fromNode.id);
          nodes.push(fromNode);
        }
      }
      if (!matchedNodeIds.has(link.toNodeId)) {
        const toNode = graph.nodes.find((n) => n.id === link.toNodeId);
        if (toNode) {
          matchedNodeIds.add(toNode.id);
          nodes.push(toNode);
        }
      }
    }
  }

  // For node-only filters, also include links between matched nodes
  if (mode === "degraded" || mode === "down") {
    for (const link of graph.links) {
      if (links.includes(link)) continue;
      if (matchedNodeIds.has(link.fromNodeId) && matchedNodeIds.has(link.toNodeId)) {
        links.push(link);
      }
    }
  }

  return {
    graph: { nodes, links },
    filteredNodeCount: nodes.length,
    filteredLinkCount: links.length,
    totalNodeCount: graph.nodes.length,
    totalLinkCount: graph.links.length,
  };
}

function matchesNodeFilter(node: RenderNodeView, mode: TopologyFilterMode): boolean {
  switch (mode) {
    case "degraded":
      return node.health === "degraded" || node.health === "down";
    case "down":
      return node.health === "down";
    case "high-latency":
      return node.latencyMs > HIGH_LATENCY_THRESHOLD_MS;
    case "high-loss":
      return node.packetLossPct > HIGH_LOSS_THRESHOLD_PCT;
    default:
      return true;
  }
}

function matchesLinkFilter(link: RenderLinkView, mode: TopologyFilterMode): boolean {
  switch (mode) {
    case "degraded":
      return link.health === "degraded" || link.health === "down";
    case "down":
      return link.health === "down";
    case "high-latency":
      return link.latencyMs > HIGH_LATENCY_THRESHOLD_MS;
    case "high-loss":
      return link.packetLossPct > HIGH_LOSS_THRESHOLD_PCT;
    default:
      return true;
  }
}
