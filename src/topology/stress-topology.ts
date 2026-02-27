import type { TopologySnapshot, NodeType, LinkMedium, HealthState } from "../contracts/domain";

export interface StressTopologyOptions {
  nodeCount?: number;
  linkCount?: number;
}

const NODE_TYPES: NodeType[] = ["tower", "backhaul", "router", "switch", "client"];
const LINK_MEDIA: LinkMedium[] = ["wireless", "wired", "fiber"];
const HEALTH_STATES: HealthState[] = ["up", "up", "up", "degraded", "down"];

export function generateStressTopology(options: StressTopologyOptions = {}): TopologySnapshot {
  const nodeCount = options.nodeCount ?? 100;
  const linkCount = options.linkCount ?? 200;
  const now = Date.now();

  const nodes = Array.from({ length: nodeCount }, (_, i) => {
    const type = NODE_TYPES[i % NODE_TYPES.length];
    const status = HEALTH_STATES[Math.floor(Math.random() * HEALTH_STATES.length)];
    return {
      id: `stress-node-${i}`,
      markerId: 1000 + i,
      type,
      label: `${type}-${i}`,
      metrics: {
        status,
        rssi: type === "tower" || type === "router" ? randInt(-80, -30) : undefined,
        snr: type === "tower" || type === "router" ? randInt(8, 40) : undefined,
        throughputMbps: randFloat(10, 800),
        latencyMs: randFloat(1, 120),
        packetLossPct: randFloat(0, 6),
        utilizationPct: randFloat(5, 95),
        updatedAtMs: now,
      },
    };
  });

  // Build links: ensure a spanning tree first, then add random extras
  const links: TopologySnapshot["links"] = [];
  const usedPairs = new Set<string>();

  const pairKey = (a: number, b: number): string =>
    a < b ? `${a}-${b}` : `${b}-${a}`;

  // Spanning tree: connect node i to a random node < i
  for (let i = 1; i < nodeCount; i++) {
    const j = Math.floor(Math.random() * i);
    const key = pairKey(i, j);
    usedPairs.add(key);
    links.push(makeLink(links.length, nodes[i].id, nodes[j].id, now));
  }

  // Fill remaining links randomly
  let attempts = 0;
  while (links.length < linkCount && attempts < linkCount * 10) {
    attempts++;
    const a = Math.floor(Math.random() * nodeCount);
    const b = Math.floor(Math.random() * nodeCount);
    if (a === b) continue;
    const key = pairKey(a, b);
    if (usedPairs.has(key)) continue;
    usedPairs.add(key);
    links.push(makeLink(links.length, nodes[a].id, nodes[b].id, now));
  }

  return { nodes, links, generatedAtMs: now };
}

function makeLink(
  index: number,
  fromNodeId: string,
  toNodeId: string,
  now: number
): TopologySnapshot["links"][number] {
  const medium = LINK_MEDIA[index % LINK_MEDIA.length];
  const status = HEALTH_STATES[Math.floor(Math.random() * HEALTH_STATES.length)];
  return {
    id: `stress-link-${index}`,
    fromNodeId,
    toNodeId,
    medium,
    metrics: {
      status,
      latencyMs: randFloat(1, 150),
      packetLossPct: randFloat(0, 8),
      utilizationPct: randFloat(5, 98),
      throughputMbps: randFloat(10, 1200),
      updatedAtMs: now,
    },
  };
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min: number, max: number): number {
  return Number((Math.random() * (max - min) + min).toFixed(2));
}
