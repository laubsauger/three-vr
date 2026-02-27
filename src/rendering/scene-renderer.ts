import {
  BufferGeometry,
  CylinderGeometry,
  Group,
  LineBasicMaterial,
  LineLoop,
  Mesh,
  MeshStandardMaterial,
  Scene,
  SphereGeometry,
  Vector3
} from "three";

import type { RenderGraphView, RenderLinkView, RenderNodeView } from "../topology";
import type { TrackedMarker, XrBoundaryPoint } from "../contracts";

const LINK_SEGMENT_COUNT = 4;
const NODE_RADIUS = 0.08;
const NODE_SPHERE_WIDTH_SEGMENTS = 12;
const NODE_SPHERE_HEIGHT_SEGMENTS = 8;
const LINK_BEAM_RADIAL_SEGMENTS = 8;
const PACKET_SPHERE_WIDTH_SEGMENTS = 8;
const PACKET_SPHERE_HEIGHT_SEGMENTS = 6;
const MIN_LINK_BEAM_RADIUS = 0.003;
const MIN_PACKET_RADIUS = 0.015;
const MARKER_LAYOUT_POSITION_EPSILON_SQ = 0.0004;
const MARKER_LAYOUT_MIN_INTERVAL_MS = 80;

interface LinkVisualState {
  group: Group;
  segments: Array<Mesh<CylinderGeometry, MeshStandardMaterial>>;
  packet: Mesh<SphereGeometry, MeshStandardMaterial>;
  flowHz: number;
  targetFlowHz: number;
  beamRadius: number;
  targetBeamRadius: number;
  path: Vector3[];
  phase: number;
}

interface SelectableMeta {
  selectableType: "node" | "link";
  selectableId: string;
}

export class InfraSceneRenderer {
  private static readonly UP = new Vector3(0, 1, 0);

  private readonly root = new Group();
  private readonly nodeGroup = new Group();
  private readonly linkGroup = new Group();
  private readonly markerAnchors = new Map<number, Vector3>();
  private readonly floatingNodePositions = new Map<string, Vector3>();
  private readonly nodeMeshes = new Map<string, Mesh<SphereGeometry, MeshStandardMaterial>>();
  private readonly linkMeshes = new Map<string, LinkVisualState>();
  private readonly linkSegmentMaterials = new Map<string, MeshStandardMaterial>();
  private readonly linkPacketMaterials = new Map<string, MeshStandardMaterial>();
  private readonly nodeGeometry = new SphereGeometry(
    1,
    NODE_SPHERE_WIDTH_SEGMENTS,
    NODE_SPHERE_HEIGHT_SEGMENTS
  );
  private readonly linkSegmentGeometry = new CylinderGeometry(
    1,
    1,
    1,
    LINK_BEAM_RADIAL_SEGMENTS,
    1,
    true
  );
  private readonly packetGeometry = new SphereGeometry(
    1,
    PACKET_SPHERE_WIDTH_SEGMENTS,
    PACKET_SPHERE_HEIGHT_SEGMENTS
  );
  private graph: RenderGraphView = { nodes: [], links: [] };
  private boundaryPolygon: XrBoundaryPoint[] | null = null;
  private boundaryLoop: LineLoop<BufferGeometry, LineBasicMaterial> | null = null;
  private readonly tmpMid = new Vector3();
  private readonly tmpDir = new Vector3();
  private lastTickSec = 0;
  private lastMarkerLayoutAtMs = 0;

  constructor(scene: Scene) {
    this.root.name = "infra-root";
    this.nodeGroup.name = "infra-nodes";
    this.linkGroup.name = "infra-links";
    this.root.add(this.linkGroup, this.nodeGroup);
    scene.add(this.root);
  }

  updateGraph(graph: RenderGraphView): void {
    this.graph = graph;

    this.syncNodeMeshes(graph.nodes);
    this.syncLinkMeshes(graph.links);
    this.recomputeLayout();
  }

  updateTrackedMarkers(markers: TrackedMarker[]): void {
    const seen = new Set<number>();
    let shouldRecompute = false;

    for (const marker of markers) {
      seen.add(marker.markerId);
      const existing = this.markerAnchors.get(marker.markerId);
      if (existing) {
        const dx = existing.x - marker.pose.position.x;
        const dy = existing.y - marker.pose.position.y;
        const dz = existing.z - marker.pose.position.z;
        if (dx * dx + dy * dy + dz * dz > MARKER_LAYOUT_POSITION_EPSILON_SQ) {
          shouldRecompute = true;
        }
        existing.set(marker.pose.position.x, marker.pose.position.y, marker.pose.position.z);
      } else {
        this.markerAnchors.set(
          marker.markerId,
          new Vector3(marker.pose.position.x, marker.pose.position.y, marker.pose.position.z)
        );
        shouldRecompute = true;
      }
    }

    const markerIds = [...this.markerAnchors.keys()];
    for (const markerId of markerIds) {
      if (seen.has(markerId)) {
        continue;
      }
      this.markerAnchors.delete(markerId);
      shouldRecompute = true;
    }

    if (!shouldRecompute) {
      return;
    }

    const now = performance.now();
    if (now - this.lastMarkerLayoutAtMs < MARKER_LAYOUT_MIN_INTERVAL_MS) {
      return;
    }
    this.lastMarkerLayoutAtMs = now;
    this.recomputeLayout();
  }

  setBoundaryPolygon(boundary: XrBoundaryPoint[] | null): void {
    this.boundaryPolygon = boundary && boundary.length >= 3 ? boundary.map((point) => ({ ...point })) : null;
    this.updateBoundaryVisual();
    this.recomputeLayout();
  }

  tick(timeMs: number): void {
    const timeSec = timeMs / 1000;
    const dt = this.lastTickSec > 0 ? Math.min(timeSec - this.lastTickSec, 0.1) : 0;
    this.lastTickSec = timeSec;
    // Framerate-independent exponential lerp (~3 units/sec convergence)
    const lerpAlpha = dt > 0 ? 1 - Math.exp(-3 * dt) : 0;

    for (const visual of this.linkMeshes.values()) {
      // Smooth interpolation of radius and packet speed
      if (lerpAlpha > 0) {
        visual.flowHz += (visual.targetFlowHz - visual.flowHz) * lerpAlpha;
        visual.beamRadius += (visual.targetBeamRadius - visual.beamRadius) * lerpAlpha;
      }

      const beamRadius = Math.max(visual.beamRadius, MIN_LINK_BEAM_RADIUS);
      const packetRadius = Math.max(MIN_PACKET_RADIUS, beamRadius * 0.78);
      const phaseTime = timeSec * visual.flowHz + visual.phase;
      const packetLead = fract(phaseTime);
      const packetTrail = Math.max(0, packetLead - 0.18);

      for (let i = 0; i < visual.segments.length; i++) {
        const segment = visual.segments[i];
        const segmentOffset = i / Math.max(visual.segments.length - 1, 1);
        const headPulse = Math.max(0, 1 - Math.abs(segmentOffset - packetLead) * 4.8);
        const trailPulse = Math.max(0, 1 - Math.abs(segmentOffset - packetTrail) * 5.8);
        const animatedRadius = beamRadius * (0.48 + headPulse * 1.55 + trailPulse * 0.4);
        segment.scale.x = animatedRadius;
        segment.scale.z = animatedRadius;
      }

      const packetPulse = 1.15 + 0.95 * (0.5 + 0.5 * Math.sin((phaseTime + 0.12) * Math.PI * 4));
      setPositionOnPath(visual.packet.position, visual.path, packetLead);
      visual.packet.scale.setScalar(packetRadius * packetPulse);
    }
  }

  getNodePositions(): Map<string, Vector3> {
    const result = new Map<string, Vector3>();
    for (const [id, mesh] of this.nodeMeshes) {
      result.set(id, mesh.position.clone());
    }
    return result;
  }

  getLinkMidpoints(): Map<string, Vector3> {
    const result = new Map<string, Vector3>();
    for (const [id, visual] of this.linkMeshes) {
      if (visual.path.length > 0) {
        const midIdx = Math.floor(visual.path.length / 2);
        result.set(id, visual.path[midIdx].clone());
      }
    }
    return result;
  }

  dispose(): void {
    for (const mesh of this.nodeMeshes.values()) {
      mesh.material.dispose();
      this.nodeGroup.remove(mesh);
    }
    this.nodeMeshes.clear();

    for (const visual of this.linkMeshes.values()) {
      this.linkGroup.remove(visual.group);
    }
    this.linkMeshes.clear();

    if (this.boundaryLoop) {
      this.boundaryLoop.geometry.dispose();
      this.boundaryLoop.material.dispose();
      this.boundaryLoop.removeFromParent();
      this.boundaryLoop = null;
    }

    this.nodeGeometry.dispose();
    this.linkSegmentGeometry.dispose();
    this.packetGeometry.dispose();
    for (const material of this.linkSegmentMaterials.values()) {
      material.dispose();
    }
    this.linkSegmentMaterials.clear();
    for (const material of this.linkPacketMaterials.values()) {
      material.dispose();
    }
    this.linkPacketMaterials.clear();
    this.root.removeFromParent();
  }

  private syncNodeMeshes(nodes: RenderNodeView[]): void {
    const nextIds = new Set(nodes.map((node) => node.id));

    for (const [nodeId, mesh] of this.nodeMeshes) {
      if (nextIds.has(nodeId)) {
        continue;
      }
      mesh.material.dispose();
      mesh.removeFromParent();
      this.nodeMeshes.delete(nodeId);
      this.floatingNodePositions.delete(nodeId);
    }

    for (const node of nodes) {
      let mesh = this.nodeMeshes.get(node.id);
      if (!mesh) {
        mesh = new Mesh(
          this.nodeGeometry,
          new MeshStandardMaterial({ color: selectNodeColor(node.health), roughness: 0.3, metalness: 0.1 })
        );
        mesh.scale.setScalar(NODE_RADIUS);
        mesh.name = `node-${node.id}`;
        const metadata: SelectableMeta = {
          selectableType: "node",
          selectableId: node.id
        };
        mesh.userData = {
          ...mesh.userData,
          ...metadata
        };
        this.nodeGroup.add(mesh);
        this.nodeMeshes.set(node.id, mesh);
      } else {
        mesh.material.color.set(selectNodeColor(node.health));
      }
    }
  }

  private syncLinkMeshes(links: RenderLinkView[]): void {
    const nextIds = new Set(links.map((link) => link.id));

    for (const [linkId, visual] of this.linkMeshes) {
      if (nextIds.has(linkId)) {
        continue;
      }
      visual.group.removeFromParent();
      this.linkMeshes.delete(linkId);
    }

    for (const link of links) {
      let visual = this.linkMeshes.get(link.id);
      if (!visual) {
        const group = new Group();
        group.name = `link-${link.id}`;
        const metadata: SelectableMeta = {
          selectableType: "link",
          selectableId: link.id
        };
        group.userData = {
          ...group.userData,
          ...metadata
        };

        const segmentMaterial = this.getSharedLinkSegmentMaterial(link.beamColorHex);
        const segments: Array<Mesh<CylinderGeometry, MeshStandardMaterial>> = [];
        for (let i = 0; i < LINK_SEGMENT_COUNT; i++) {
          const segment = new Mesh(
            this.linkSegmentGeometry,
            segmentMaterial
          );
          segment.name = `link-segment-${link.id}-${i}`;
          segments.push(segment);
          group.add(segment);
        }

        const initialBeamRadius = Math.max(link.trafficRadius, MIN_LINK_BEAM_RADIUS);
        const initialPacketRadius = Math.max(MIN_PACKET_RADIUS, initialBeamRadius * 0.78);
        const packet = new Mesh(
          this.packetGeometry,
          this.getSharedLinkPacketMaterial(link.beamColorHex)
        );

        group.add(packet);
        this.linkGroup.add(group);

        for (const segment of segments) {
          segment.scale.x = initialBeamRadius;
          segment.scale.z = initialBeamRadius;
        }
        packet.scale.setScalar(initialPacketRadius);

        visual = {
          group,
          segments,
          packet,
          flowHz: link.flowHz,
          targetFlowHz: link.flowHz,
          beamRadius: link.trafficRadius,
          targetBeamRadius: link.trafficRadius,
          path: createPathBuffer(LINK_SEGMENT_COUNT + 1),
          phase: Math.random()
        };
        this.linkMeshes.set(link.id, visual);
      } else {
        visual.targetFlowHz = link.flowHz;
        visual.targetBeamRadius = link.trafficRadius;
      }

      const nextSegmentMaterial = this.getSharedLinkSegmentMaterial(link.beamColorHex);
      for (const segment of visual.segments) {
        if (segment.material !== nextSegmentMaterial) {
          segment.material = nextSegmentMaterial;
        }
      }
      const nextPacketMaterial = this.getSharedLinkPacketMaterial(link.beamColorHex);
      if (visual.packet.material !== nextPacketMaterial) {
        visual.packet.material = nextPacketMaterial;
      }
    }
  }

  private recomputeLayout(): void {
    const positions = this.resolveNodePositions(this.graph.nodes);

    for (const node of this.graph.nodes) {
      const mesh = this.nodeMeshes.get(node.id);
      const position = positions.get(node.id);
      if (!mesh || !position) {
        continue;
      }
      mesh.position.copy(position);
    }

    for (const link of this.graph.links) {
      const visual = this.linkMeshes.get(link.id);
      const from = positions.get(link.fromNodeId);
      const to = positions.get(link.toNodeId);
      if (!visual || !from || !to) {
        continue;
      }

      this.fillConstrainedPath(visual.path, from, to);
      const path = visual.path;

      for (let i = 0; i < visual.segments.length; i++) {
        const a = path[i];
        const b = path[i + 1];
        const segment = visual.segments[i];
        if (!a || !b) {
          segment.visible = false;
          continue;
        }
        this.updateBeamTransform(segment, a, b);
      }
    }
  }

  private fillConstrainedPath(path: Vector3[], from: Vector3, to: Vector3): void {
    const count = Math.max(path.length, 2);

    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);
      const point = path[i] ?? new Vector3();
      point.set(
        from.x + (to.x - from.x) * t,
        from.y + (to.y - from.y) * t,
        from.z + (to.z - from.z) * t
      );
      this.clampToBoundaryInPlace(point);
      path[i] = point;
    }
  }

  private updateBeamTransform(
    beam: Mesh<CylinderGeometry, MeshStandardMaterial>,
    from: Vector3,
    to: Vector3
  ): void {
    this.tmpDir.copy(to).sub(from);
    const length = this.tmpDir.length();
    if (length < 0.001) {
      beam.visible = false;
      return;
    }

    beam.visible = true;
    this.tmpDir.normalize();
    beam.quaternion.setFromUnitVectors(InfraSceneRenderer.UP, this.tmpDir);
    this.tmpMid.copy(from).add(to).multiplyScalar(0.5);
    beam.position.copy(this.tmpMid);
    // Only set y (segment length); x/z are managed by tick() for smooth radius
    beam.scale.y = length;
  }

  private resolveNodePositions(nodes: RenderNodeView[]): Map<string, Vector3> {
    const output = new Map<string, Vector3>();
    const anchored: RenderNodeView[] = [];
    const floating: RenderNodeView[] = [];

    for (const node of nodes) {
      if (this.markerAnchors.has(node.markerId)) {
        anchored.push(node);
      } else {
        floating.push(node);
      }
    }

    for (const node of anchored) {
      const position = this.markerAnchors.get(node.markerId);
      if (position) {
        output.set(node.id, this.clampToBoundary(position));
      }
    }

    const center = this.getPreferredCenter();
    const baseRadius = this.getPreferredRadius(center.x, center.z);
    const centerY = 1.35;
    const count = Math.max(floating.length, 1);

    // Scale radius so adjacent nodes have at least ~0.22m arc spacing
    const minArcSpacing = 0.22;
    const neededRadius = (count * minArcSpacing) / (Math.PI * 2);
    const radius = Math.max(baseRadius, neededRadius);

    floating.forEach((node, index) => {
      // Distribute across 2 concentric rings for better spread
      const ring = index % 2;
      const ringRadius = radius * (1 + ring * 0.35);
      const ringOffset = ring * (Math.PI / count); // stagger inner/outer
      const angle = (index / count) * Math.PI * 2 + ringOffset;
      const candidate = this.floatingNodePositions.get(node.id) ?? new Vector3();
      candidate.set(
        center.x + Math.cos(angle) * ringRadius,
        centerY + 0.20 * Math.sin(index * 0.8),
        center.z + Math.sin(angle) * ringRadius * 0.7
      );
      this.floatingNodePositions.set(node.id, candidate);
      output.set(node.id, this.clampToBoundary(candidate));
    });

    return output;
  }

  private getPreferredCenter(): { x: number; z: number } {
    if (!this.boundaryPolygon || this.boundaryPolygon.length === 0) {
      return { x: 0, z: -1.2 };
    }

    let sumX = 0;
    let sumZ = 0;
    for (const point of this.boundaryPolygon) {
      sumX += point.x;
      sumZ += point.z;
    }

    return {
      x: sumX / this.boundaryPolygon.length,
      z: sumZ / this.boundaryPolygon.length
    };
  }

  private getPreferredRadius(centerX: number, centerZ: number): number {
    if (!this.boundaryPolygon || this.boundaryPolygon.length < 3) {
      return 0.9;
    }

    const distances = this.boundaryPolygon.map((point) =>
      Math.hypot(point.x - centerX, point.z - centerZ)
    );
    const minRadius = Math.min(...distances);
    return Math.max(0.35, minRadius * 0.62);
  }

  private clampToBoundary(position: Vector3): Vector3 {
    const clamped = position.clone();
    this.clampToBoundaryInPlace(clamped);
    return clamped;
  }

  private clampToBoundaryInPlace(position: Vector3): void {
    if (!this.boundaryPolygon || this.boundaryPolygon.length < 3) {
      return;
    }

    if (isInsidePolygon(position.x, position.z, this.boundaryPolygon)) {
      return;
    }

    const closest = closestPointOnPolygon(position.x, position.z, this.boundaryPolygon);
    position.x = closest.x;
    position.z = closest.z;
  }

  private updateBoundaryVisual(): void {
    if (this.boundaryLoop) {
      this.boundaryLoop.geometry.dispose();
      this.boundaryLoop.material.dispose();
      this.boundaryLoop.removeFromParent();
      this.boundaryLoop = null;
    }

    if (!this.boundaryPolygon || this.boundaryPolygon.length < 3) {
      return;
    }

    const geometry = new BufferGeometry();
    geometry.setFromPoints(this.boundaryPolygon.map((point) => new Vector3(point.x, 0.02, point.z)));
    const material = new LineBasicMaterial({
      color: "#4fd5ff",
      transparent: true,
      opacity: 0.45
    });
    this.boundaryLoop = new LineLoop(geometry, material);
    this.boundaryLoop.name = "room-boundary";
    this.root.add(this.boundaryLoop);
  }

  private getSharedLinkSegmentMaterial(colorHex: string): MeshStandardMaterial {
    let material = this.linkSegmentMaterials.get(colorHex);
    if (!material) {
      material = new MeshStandardMaterial({
        color: colorHex,
        emissive: colorHex,
        emissiveIntensity: 0.26,
        metalness: 0.12,
        roughness: 0.42
      });
      this.linkSegmentMaterials.set(colorHex, material);
    }
    return material;
  }

  private getSharedLinkPacketMaterial(colorHex: string): MeshStandardMaterial {
    let material = this.linkPacketMaterials.get(colorHex);
    if (!material) {
      material = new MeshStandardMaterial({
        color: colorHex,
        emissive: colorHex,
        emissiveIntensity: 0.95,
        metalness: 0.04,
        roughness: 0.28
      });
      this.linkPacketMaterials.set(colorHex, material);
    }
    return material;
  }
}

function fract(value: number): number {
  return value - Math.floor(value);
}

function setPositionOnPath(target: Vector3, path: Vector3[], t: number): void {
  if (path.length === 0) {
    target.set(0, 0, 0);
    return;
  }
  if (path.length === 1) {
    target.copy(path[0]);
    return;
  }

  const scaled = t * (path.length - 1);
  const index = Math.floor(scaled);
  const nextIndex = Math.min(index + 1, path.length - 1);
  const localT = scaled - index;
  const a = path[index];
  const b = path[nextIndex];

  target.set(
    a.x + (b.x - a.x) * localT,
    a.y + (b.y - a.y) * localT,
    a.z + (b.z - a.z) * localT
  );
}

function createPathBuffer(pointCount: number): Vector3[] {
  return Array.from({ length: Math.max(pointCount, 2) }, () => new Vector3());
}

function isInsidePolygon(x: number, z: number, polygon: XrBoundaryPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const zi = polygon[i].z;
    const xj = polygon[j].x;
    const zj = polygon[j].z;

    const intersects = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-8) + xi;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function closestPointOnPolygon(x: number, z: number, polygon: XrBoundaryPoint[]): XrBoundaryPoint {
  let best: XrBoundaryPoint = { x: polygon[0].x, z: polygon[0].z };
  let bestDistSq = Number.POSITIVE_INFINITY;

  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const projected = projectPointToSegment(x, z, a, b);
    const distSq = (projected.x - x) * (projected.x - x) + (projected.z - z) * (projected.z - z);
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      best = projected;
    }
  }

  return best;
}

function projectPointToSegment(
  x: number,
  z: number,
  a: XrBoundaryPoint,
  b: XrBoundaryPoint
): XrBoundaryPoint {
  const abX = b.x - a.x;
  const abZ = b.z - a.z;
  const abLenSq = abX * abX + abZ * abZ;
  if (abLenSq < 1e-8) {
    return { x: a.x, z: a.z };
  }

  const t = ((x - a.x) * abX + (z - a.z) * abZ) / abLenSq;
  const clampedT = Math.max(0, Math.min(1, t));
  return {
    x: a.x + abX * clampedT,
    z: a.z + abZ * clampedT
  };
}

function selectNodeColor(status: RenderNodeView["health"]): string {
  if (status === "up") {
    return "#3ed58a";
  }
  if (status === "degraded") {
    return "#ffcf52";
  }
  if (status === "down") {
    return "#ff6464";
  }
  return "#8ea7b2";
}
