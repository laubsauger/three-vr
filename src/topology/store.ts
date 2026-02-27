import type {
  InfraLink,
  InfraNode,
  LinkMetricUpdate,
  NodeMetricUpdate,
  TopologySnapshot
} from "../contracts/domain";

export interface TopologyDeltaResult {
  changedNodeIds: string[];
  changedLinkIds: string[];
  snapshot: TopologySnapshot;
}

export class TopologyStore {
  private nodes = new Map<string, InfraNode>();
  private links = new Map<string, InfraLink>();
  private generatedAtMs = 0;

  loadSnapshot(snapshot: TopologySnapshot): TopologySnapshot {
    this.nodes.clear();
    this.links.clear();

    for (const node of snapshot.nodes) {
      this.nodes.set(node.id, structuredClone(node));
    }
    for (const link of snapshot.links) {
      this.links.set(link.id, structuredClone(link));
    }

    this.generatedAtMs = snapshot.generatedAtMs;
    return this.getSnapshot();
  }

  applyMetricUpdates(
    nodeMetrics: NodeMetricUpdate[],
    linkMetrics: LinkMetricUpdate[],
    timestampMs: number
  ): TopologyDeltaResult {
    const changedNodeIds: string[] = [];
    const changedLinkIds: string[] = [];

    for (const patch of nodeMetrics) {
      const node = this.nodes.get(patch.nodeId);
      if (!node) {
        continue;
      }

      node.metrics = {
        ...node.metrics,
        ...patch.metrics,
        updatedAtMs: patch.metrics.updatedAtMs ?? timestampMs
      };
      changedNodeIds.push(node.id);
    }

    for (const patch of linkMetrics) {
      const link = this.links.get(patch.linkId);
      if (!link) {
        continue;
      }

      link.metrics = {
        ...link.metrics,
        ...patch.metrics,
        updatedAtMs: patch.metrics.updatedAtMs ?? timestampMs
      };
      changedLinkIds.push(link.id);
    }

    this.generatedAtMs = timestampMs;

    return {
      changedNodeIds,
      changedLinkIds,
      snapshot: this.getSnapshot()
    };
  }

  getSnapshot(): TopologySnapshot {
    return {
      generatedAtMs: this.generatedAtMs,
      nodes: [...this.nodes.values()].map((node) => structuredClone(node)),
      links: [...this.links.values()].map((link) => structuredClone(link))
    };
  }

  getNode(nodeId: string): InfraNode | null {
    const node = this.nodes.get(nodeId);
    return node ? structuredClone(node) : null;
  }

  getLinksForNode(nodeId: string): InfraLink[] {
    return [...this.links.values()]
      .filter((link) => link.fromNodeId === nodeId || link.toNodeId === nodeId)
      .map((link) => structuredClone(link));
  }
}
