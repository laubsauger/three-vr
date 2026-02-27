import type {
  LinkMetricUpdate,
  NodeMetricUpdate,
  TopologySnapshot
} from "../contracts/domain";
import type { AppEventMap } from "../contracts/events";

interface MockTelemetryBatch {
  nodeMetrics: NodeMetricUpdate[];
  linkMetrics: LinkMetricUpdate[];
}

export class MockTelemetryStream {
  private snapshot: TopologySnapshot | null = null;

  setSnapshot(snapshot: TopologySnapshot): void {
    this.snapshot = snapshot;
  }

  generateBatch(timestampMs: number): MockTelemetryBatch {
    if (!this.snapshot) {
      return {
        nodeMetrics: [],
        linkMetrics: []
      };
    }

    const nodeMetrics = this.generateNodeUpdates(timestampMs);
    const linkMetrics = this.generateLinkUpdates(timestampMs);

    return {
      nodeMetrics,
      linkMetrics
    };
  }

  applyBatch(
    snapshot: TopologySnapshot,
    update: AppEventMap["telemetry/update"]
  ): TopologySnapshot {
    const nodes = snapshot.nodes.map((node) => {
      const patch = update.nodeMetrics.find((metric) => metric.nodeId === node.id);
      if (!patch) {
        return node;
      }
      return {
        ...node,
        metrics: {
          ...node.metrics,
          ...patch.metrics,
          updatedAtMs: patch.metrics.updatedAtMs ?? update.timestampMs
        }
      };
    });

    const links = snapshot.links.map((link) => {
      const patch = update.linkMetrics.find((metric) => metric.linkId === link.id);
      if (!patch) {
        return link;
      }
      return {
        ...link,
        metrics: {
          ...link.metrics,
          ...patch.metrics,
          updatedAtMs: patch.metrics.updatedAtMs ?? update.timestampMs
        }
      };
    });

    const next = {
      ...snapshot,
      generatedAtMs: update.timestampMs,
      nodes,
      links
    };

    this.snapshot = next;
    return next;
  }

  private generateNodeUpdates(timestampMs: number): NodeMetricUpdate[] {
    if (!this.snapshot || this.snapshot.nodes.length === 0) {
      return [];
    }

    const node = randomElement(this.snapshot.nodes);
    if (!node) {
      return [];
    }

    const utilization = boundedJitter(node.metrics.utilizationPct ?? 45, 8, 0, 100);
    const latency = boundedJitter(node.metrics.latencyMs ?? 14, 3, 1, 120);
    const packetLoss = boundedJitter(node.metrics.packetLossPct ?? 0.4, 0.5, 0, 100);
    const throughput = boundedJitter(node.metrics.throughputMbps ?? 120, 25, 0, 1200);
    const status = deriveStatus(latency, packetLoss);

    return [
      {
        nodeId: node.id,
        metrics: {
          status,
          utilizationPct: utilization,
          latencyMs: latency,
          packetLossPct: packetLoss,
          throughputMbps: throughput,
          updatedAtMs: timestampMs
        }
      }
    ];
  }

  private generateLinkUpdates(timestampMs: number): LinkMetricUpdate[] {
    if (!this.snapshot || this.snapshot.links.length === 0) {
      return [];
    }

    const link = randomElement(this.snapshot.links);
    if (!link) {
      return [];
    }

    const utilization = boundedJitter(link.metrics.utilizationPct ?? 50, 10, 0, 100);
    const latency = boundedJitter(link.metrics.latencyMs ?? 20, 4, 1, 220);
    const packetLoss = boundedJitter(link.metrics.packetLossPct ?? 0.7, 0.8, 0, 100);
    const throughput = boundedJitter(link.metrics.throughputMbps ?? 160, 30, 0, 1500);
    const status = deriveStatus(latency, packetLoss);

    return [
      {
        linkId: link.id,
        metrics: {
          status,
          utilizationPct: utilization,
          latencyMs: latency,
          packetLossPct: packetLoss,
          throughputMbps: throughput,
          updatedAtMs: timestampMs
        }
      }
    ];
  }
}

function randomElement<T>(items: T[]): T | null {
  if (items.length === 0) {
    return null;
  }
  const index = Math.floor(Math.random() * items.length);
  return items[index] ?? null;
}

function boundedJitter(value: number, delta: number, min: number, max: number): number {
  const jitter = (Math.random() * 2 - 1) * delta;
  const next = value + jitter;
  return Number(Math.max(min, Math.min(max, next)).toFixed(2));
}

function deriveStatus(latencyMs: number, packetLossPct: number): "up" | "degraded" | "down" {
  if (latencyMs > 140 || packetLossPct > 8) {
    return "down";
  }
  if (latencyMs > 45 || packetLossPct > 1.8) {
    return "degraded";
  }
  return "up";
}
