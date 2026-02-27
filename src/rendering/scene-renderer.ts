import {
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
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

const LINK_SEGMENT_COUNT = 12;

interface LinkVisualState {
  group: Group;
  segments: Array<Mesh<CylinderGeometry, MeshStandardMaterial>>;
  packetA: Mesh<SphereGeometry, MeshStandardMaterial>;
  packetB: Mesh<SphereGeometry, MeshStandardMaterial>;
  flowHz: number;
  beamRadius: number;
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
  private readonly nodeMeshes = new Map<string, Mesh<SphereGeometry, MeshStandardMaterial>>();
  private readonly linkMeshes = new Map<string, LinkVisualState>();
  private graph: RenderGraphView = { nodes: [], links: [] };
  private boundaryPolygon: XrBoundaryPoint[] | null = null;
  private boundaryLoop: LineLoop<BufferGeometry, LineBasicMaterial> | null = null;
  private readonly tmpMid = new Vector3();
  private readonly tmpDir = new Vector3();

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
    for (const marker of markers) {
      this.markerAnchors.set(
        marker.markerId,
        new Vector3(marker.pose.position.x, marker.pose.position.y, marker.pose.position.z)
      );
    }
    this.recomputeLayout();
  }

  setBoundaryPolygon(boundary: XrBoundaryPoint[] | null): void {
    this.boundaryPolygon = boundary && boundary.length >= 3 ? boundary.map((point) => ({ ...point })) : null;
    this.updateBoundaryVisual();
    this.recomputeLayout();
  }

  tick(timeMs: number): void {
    const timeSec = timeMs / 1000;
    for (const visual of this.linkMeshes.values()) {
      const basePulse =
        0.42 + 0.58 * (0.5 + 0.5 * Math.sin((timeSec * visual.flowHz + visual.phase) * Math.PI * 2));

      for (let i = 0; i < visual.segments.length; i++) {
        const segment = visual.segments[i];
        const offset = i / Math.max(visual.segments.length - 1, 1);
        const stagger = 0.82 + 0.18 * Math.sin((timeSec * visual.flowHz + visual.phase + offset) * Math.PI * 2);
        segment.material.opacity = 0.28 + basePulse * 0.28 * stagger;
        segment.material.emissiveIntensity = 0.16 + basePulse * 0.42 * stagger;
      }

      const packetLead = fract(timeSec * visual.flowHz + visual.phase);
      const packetTrail = fract(packetLead + 0.5);
      setPositionOnPath(visual.packetA.position, visual.path, packetLead);
      setPositionOnPath(visual.packetB.position, visual.path, packetTrail);

      const packetFlash =
        0.5 + 0.5 * Math.sin((timeSec * visual.flowHz + visual.phase + 0.15) * Math.PI * 4);
      visual.packetA.material.emissiveIntensity = 0.84 + packetFlash * 0.95;
      visual.packetB.material.emissiveIntensity = 0.84 + packetFlash * 0.95;
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
      mesh.geometry.dispose();
      mesh.material.dispose();
      this.nodeGroup.remove(mesh);
    }
    this.nodeMeshes.clear();

    for (const visual of this.linkMeshes.values()) {
      for (const segment of visual.segments) {
        segment.geometry.dispose();
        segment.material.dispose();
      }
      visual.packetA.geometry.dispose();
      visual.packetA.material.dispose();
      visual.packetB.geometry.dispose();
      visual.packetB.material.dispose();
      this.linkGroup.remove(visual.group);
    }
    this.linkMeshes.clear();

    if (this.boundaryLoop) {
      this.boundaryLoop.geometry.dispose();
      this.boundaryLoop.material.dispose();
      this.boundaryLoop.removeFromParent();
      this.boundaryLoop = null;
    }

    this.root.removeFromParent();
  }

  private syncNodeMeshes(nodes: RenderNodeView[]): void {
    const nextIds = new Set(nodes.map((node) => node.id));

    for (const [nodeId, mesh] of this.nodeMeshes) {
      if (nextIds.has(nodeId)) {
        continue;
      }
      mesh.geometry.dispose();
      mesh.material.dispose();
      mesh.removeFromParent();
      this.nodeMeshes.delete(nodeId);
    }

    for (const node of nodes) {
      let mesh = this.nodeMeshes.get(node.id);
      if (!mesh) {
        mesh = new Mesh(
          new SphereGeometry(0.08, 20, 16),
          new MeshStandardMaterial({ color: selectNodeColor(node.health), roughness: 0.3, metalness: 0.1 })
        );
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
        mesh.material.color = new Color(selectNodeColor(node.health));
      }
    }
  }

  private syncLinkMeshes(links: RenderLinkView[]): void {
    const nextIds = new Set(links.map((link) => link.id));

    for (const [linkId, visual] of this.linkMeshes) {
      if (nextIds.has(linkId)) {
        continue;
      }
      for (const segment of visual.segments) {
        segment.geometry.dispose();
        segment.material.dispose();
      }
      visual.packetA.geometry.dispose();
      visual.packetA.material.dispose();
      visual.packetB.geometry.dispose();
      visual.packetB.material.dispose();
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

        const segments: Array<Mesh<CylinderGeometry, MeshStandardMaterial>> = [];
        for (let i = 0; i < LINK_SEGMENT_COUNT; i++) {
          const segment = new Mesh(
            new CylinderGeometry(link.beamRadius, link.beamRadius, 1, 14, 1, true),
            new MeshStandardMaterial({
              color: link.beamColorHex,
              emissive: link.beamColorHex,
              emissiveIntensity: 0.36,
              transparent: true,
              opacity: 0.5,
              metalness: 0.2,
              roughness: 0.24,
              side: DoubleSide
            })
          );
          segment.name = `link-segment-${link.id}-${i}`;
          segments.push(segment);
          group.add(segment);
        }

        const packetRadius = Math.max(0.015, link.beamRadius * 0.78);
        const packetA = new Mesh(
          new SphereGeometry(packetRadius, 14, 10),
          new MeshStandardMaterial({
            color: link.beamColorHex,
            emissive: link.beamColorHex,
            emissiveIntensity: 1.1,
            metalness: 0.08,
            roughness: 0.2
          })
        );
        const packetB = new Mesh(
          new SphereGeometry(packetRadius, 14, 10),
          new MeshStandardMaterial({
            color: link.beamColorHex,
            emissive: link.beamColorHex,
            emissiveIntensity: 1.1,
            metalness: 0.08,
            roughness: 0.2
          })
        );

        group.add(packetA, packetB);
        this.linkGroup.add(group);

        visual = {
          group,
          segments,
          packetA,
          packetB,
          flowHz: link.flowHz,
          beamRadius: link.beamRadius,
          path: [],
          phase: Math.random()
        };
        this.linkMeshes.set(link.id, visual);
      } else {
        visual.flowHz = link.flowHz;
        if (Math.abs(visual.beamRadius - link.beamRadius) > 0.0001) {
          for (const segment of visual.segments) {
            segment.geometry.dispose();
            segment.geometry = new CylinderGeometry(link.beamRadius, link.beamRadius, 1, 14, 1, true);
          }
          visual.beamRadius = link.beamRadius;
        }
      }

      for (const segment of visual.segments) {
        segment.material.color = new Color(link.beamColorHex);
        segment.material.emissive = new Color(link.beamColorHex);
      }
      visual.packetA.material.color = new Color(link.beamColorHex);
      visual.packetA.material.emissive = new Color(link.beamColorHex);
      visual.packetB.material.color = new Color(link.beamColorHex);
      visual.packetB.material.emissive = new Color(link.beamColorHex);
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

      const path = this.buildConstrainedPath(from, to, LINK_SEGMENT_COUNT + 1);
      visual.path = path;

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

  private buildConstrainedPath(from: Vector3, to: Vector3, samples: number): Vector3[] {
    const path: Vector3[] = [];
    const count = Math.max(samples, 2);

    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);
      const point = new Vector3(
        from.x + (to.x - from.x) * t,
        from.y + (to.y - from.y) * t,
        from.z + (to.z - from.z) * t
      );
      path.push(this.clampToBoundary(point));
    }

    return path;
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
    beam.scale.set(1, length, 1);
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
    const radius = this.getPreferredRadius(center.x, center.z);
    const centerY = 1.35;
    const count = Math.max(floating.length, 1);

    floating.forEach((node, index) => {
      const angle = (index / count) * Math.PI * 2;
      const candidate = new Vector3(
        center.x + Math.cos(angle) * radius,
        centerY + 0.15 * Math.sin(index),
        center.z + Math.sin(angle) * radius * 0.7
      );
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
    if (!this.boundaryPolygon || this.boundaryPolygon.length < 3) {
      return position.clone();
    }

    if (isInsidePolygon(position.x, position.z, this.boundaryPolygon)) {
      return position.clone();
    }

    const closest = closestPointOnPolygon(position.x, position.z, this.boundaryPolygon);
    return new Vector3(closest.x, position.y, closest.z);
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
