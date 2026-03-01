import type { TopologySnapshot, NodeType, LinkMedium, HealthState } from "../contracts/domain";
import { parseKml } from "../kml/parser";
import { geoToLocal } from "../kml";

export interface StressTopologyOptions {
  nodeCount?: number;
  linkCount?: number;
  kmlText?: string;
}

const NODE_TYPES: NodeType[] = ["tower", "backhaul", "router", "switch", "client"];
const LINK_MEDIA: LinkMedium[] = ["wireless", "wired", "fiber"];
const HEALTH_STATES: HealthState[] = ["up", "up", "up", "degraded", "down"];
const KML_ANCHOR_SITE_PREFIX = "chowtower-rf-sector";

export function generateStressTopology(options: StressTopologyOptions = {}): TopologySnapshot {
  const now = Date.now();

  if (options.kmlText) {
    const network = parseKml(options.kmlText);

    if (network.sites.length > 0) {
      const anchorSite =
        network.sites.find((site) =>
          site.name.toLowerCase().startsWith(KML_ANCHOR_SITE_PREFIX)
        ) ??
        network.sites.find((site) => site.name.toLowerCase().includes("chowtower")) ??
        network.sites[0];
      // Create basic nodes
      const nodes = network.sites.map((site, i) => {
        const type = site.name.toLowerCase().includes("tower") ? "tower" : (site.name.toLowerCase().includes("switch") ? "switch" : "router");
        const status = HEALTH_STATES[Math.floor(Math.random() * HEALTH_STATES.length)];
        const cleanName = site.name
          .replace(/-rf-/g, " ")
          .replace(/sector-/g, "s-")
          .replace(/ptp-/g, "\u2192")
          .replace(/st-/g, "st ")
          .replace(/:[0-9a-fA-F]{2}$/i, "")
          .slice(0, 18);
        const localOffset = geoToLocal(site.lat, site.lon, site.alt, {
          lat: anchorSite.lat,
          lon: anchorSite.lon,
          alt: anchorSite.alt
        });

        return {
          id: site.id,
          markerId: 1000 + i, // Temp, will update the most connected later
          type: type as NodeType,
          label: cleanName,
          layoutOffsetMeters: localOffset,
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
          // Add raw coordinates for nearest neighbor matching
          _coords: { lat: site.lat, lon: site.lon, alt: site.alt }
        };
      });

      // Create links
      const links: TopologySnapshot["links"] = [];
      const usedPairs = new Set<string>();

      for (let i = 0; i < network.links.length; i++) {
        const link = network.links[i];
        if (link.points.length < 2) continue;

        // Find nearest nodes to the endpoints
        const first = link.points[0];
        const last = link.points[link.points.length - 1];

        const fromNode = findNearestNode(nodes, first);
        const toNode = findNearestNode(nodes, last);

        if (!fromNode || !toNode || fromNode.id === toNode.id) continue;

        const pairKey = [fromNode.id, toNode.id].sort().join("-");
        if (usedPairs.has(pairKey)) continue;
        usedPairs.has(pairKey);

        const medium = link.name.toLowerCase().includes("wireless") ? "wireless" : "fiber";
        const status = HEALTH_STATES[Math.floor(Math.random() * HEALTH_STATES.length)];

        links.push({
          id: link.id || `kml-link-${i}`,
          fromNodeId: fromNode.id,
          toNodeId: toNode.id,
          medium: medium as LinkMedium,
          metrics: {
            status,
            latencyMs: randFloat(1, 150),
            packetLossPct: randFloat(0, 8),
            utilizationPct: randFloat(5, 98),
            throughputMbps: randFloat(10, 1200),
            updatedAtMs: now,
          },
        });
      }

      // Assign marker 0 to the chosen anchor site.
      const anchorNodeId = nodes.find((node) => node.id === anchorSite.id)?.id ?? nodes[0].id;
      const mappedNodes = nodes.map(n => {
        const { _coords, ...cleanNode } = n;
        if (cleanNode.id === anchorNodeId) {
          cleanNode.markerId = 0;
        }
        return cleanNode;
      });

      return { nodes: mappedNodes, links, generatedAtMs: now };
    }
  }

  const nodeCount = options.nodeCount ?? 100;
  const linkCount = options.linkCount ?? 200;

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

function findNearestNode(nodes: Array<any>, point: { lat: number; lon: number; alt: number }) {
  let nearest = null;
  let minDist = Infinity;
  for (const node of nodes) {
    const dx = node._coords.lat - point.lat;
    const dy = node._coords.lon - point.lon;
    const dist = dx * dx + dy * dy;
    if (dist < minDist) {
      minDist = dist;
      nearest = node;
    }
  }
  return nearest;
}
