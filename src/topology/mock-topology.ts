import type { TopologySnapshot } from "../contracts/domain";

export async function loadMockTopologySnapshot(): Promise<TopologySnapshot> {
  const now = Date.now();

  return {
    generatedAtMs: now,
    nodes: [
      {
        id: "tower-1",
        markerId: 101,
        type: "tower",
        label: "Town Tower",
        metrics: {
          status: "up",
          rssi: -51,
          snr: 30,
          throughputMbps: 430,
          updatedAtMs: now
        }
      },
      {
        id: "home-1",
        markerId: 102,
        type: "router",
        label: "Home Router A",
        metrics: {
          status: "up",
          rssi: -60,
          snr: 24,
          throughputMbps: 185,
          latencyMs: 11,
          packetLossPct: 0.2,
          utilizationPct: 42,
          updatedAtMs: now
        }
      },
      {
        id: "home-2",
        markerId: 103,
        type: "router",
        label: "Home Router B",
        metrics: {
          status: "up",
          rssi: -58,
          snr: 25,
          throughputMbps: 204,
          latencyMs: 13,
          packetLossPct: 0.3,
          utilizationPct: 49,
          updatedAtMs: now
        }
      },
      {
        id: "office-switch-1",
        markerId: 301,
        type: "switch",
        label: "Office Switch",
        metrics: {
          status: "up",
          throughputMbps: 910,
          latencyMs: 3,
          utilizationPct: 58,
          updatedAtMs: now
        }
      },
      {
        id: "client-1",
        markerId: 401,
        type: "client",
        label: "Client Device",
        metrics: {
          status: "up",
          rssi: -64,
          snr: 19,
          throughputMbps: 78,
          latencyMs: 18,
          packetLossPct: 0.8,
          utilizationPct: 32,
          updatedAtMs: now
        }
      }
    ],
    links: [
      {
        id: "link-tower-home1",
        fromNodeId: "tower-1",
        toNodeId: "home-1",
        medium: "wireless",
        metrics: {
          status: "up",
          latencyMs: 19,
          packetLossPct: 0.4,
          utilizationPct: 55,
          throughputMbps: 190,
          updatedAtMs: now
        }
      },
      {
        id: "link-tower-home2",
        fromNodeId: "tower-1",
        toNodeId: "home-2",
        medium: "wireless",
        metrics: {
          status: "up",
          latencyMs: 16,
          packetLossPct: 0.2,
          utilizationPct: 48,
          throughputMbps: 214,
          updatedAtMs: now
        }
      },
      {
        id: "link-home1-office",
        fromNodeId: "home-1",
        toNodeId: "office-switch-1",
        medium: "wired",
        metrics: {
          status: "up",
          latencyMs: 2,
          packetLossPct: 0,
          utilizationPct: 44,
          throughputMbps: 630,
          updatedAtMs: now
        }
      },
      {
        id: "link-home1-client",
        fromNodeId: "home-1",
        toNodeId: "client-1",
        medium: "wireless",
        metrics: {
          status: "up",
          latencyMs: 23,
          packetLossPct: 0.9,
          utilizationPct: 36,
          throughputMbps: 82,
          updatedAtMs: now
        }
      }
    ]
  };
}
