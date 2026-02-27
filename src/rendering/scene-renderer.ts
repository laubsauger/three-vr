import {
  BufferGeometry,
  Color,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshStandardMaterial,
  Scene,
  SphereGeometry,
  Vector3
} from "three";

import type { RenderGraphView, RenderLinkView, RenderNodeView } from "../topology";
import type { TrackedMarker } from "../contracts";

interface LinkVisualState {
  line: Line<BufferGeometry, LineBasicMaterial>;
  pulseHz: number;
}

interface SelectableMeta {
  selectableType: "node" | "link";
  selectableId: string;
}

export class InfraSceneRenderer {
  private readonly root = new Group();
  private readonly nodeGroup = new Group();
  private readonly linkGroup = new Group();
  private readonly markerAnchors = new Map<number, Vector3>();
  private readonly nodeMeshes = new Map<string, Mesh<SphereGeometry, MeshStandardMaterial>>();
  private readonly linkMeshes = new Map<string, LinkVisualState>();
  private graph: RenderGraphView = { nodes: [], links: [] };

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

  tick(timeMs: number): void {
    const timeSec = timeMs / 1000;
    for (const visual of this.linkMeshes.values()) {
      const intensity = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(timeSec * visual.pulseHz * Math.PI * 2));
      visual.line.material.opacity = intensity;
    }
  }

  dispose(): void {
    for (const mesh of this.nodeMeshes.values()) {
      mesh.geometry.dispose();
      mesh.material.dispose();
      this.nodeGroup.remove(mesh);
    }
    this.nodeMeshes.clear();

    for (const visual of this.linkMeshes.values()) {
      visual.line.geometry.dispose();
      visual.line.material.dispose();
      this.linkGroup.remove(visual.line);
    }
    this.linkMeshes.clear();

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
      visual.line.geometry.dispose();
      visual.line.material.dispose();
      visual.line.removeFromParent();
      this.linkMeshes.delete(linkId);
    }

    for (const link of links) {
      let visual = this.linkMeshes.get(link.id);
      if (!visual) {
        const geometry = new BufferGeometry();
        geometry.setFromPoints([new Vector3(), new Vector3()]);
        const material = new LineBasicMaterial({
          color: link.beamColorHex,
          transparent: true,
          opacity: 0.8
        });
        const line = new Line(geometry, material);
        line.name = `link-${link.id}`;
        const metadata: SelectableMeta = {
          selectableType: "link",
          selectableId: link.id
        };
        line.userData = {
          ...line.userData,
          ...metadata
        };
        this.linkGroup.add(line);

        visual = { line, pulseHz: link.pulseHz };
        this.linkMeshes.set(link.id, visual);
      } else {
        visual.line.material.color = new Color(link.beamColorHex);
        visual.pulseHz = link.pulseHz;
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
      visual.line.geometry.setFromPoints([from, to]);
      visual.line.geometry.computeBoundingSphere();
    }
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
        output.set(node.id, position.clone());
      }
    }

    const radius = 1.4;
    const centerY = 1.35;
    const centerZ = -1.5;
    const count = Math.max(floating.length, 1);

    floating.forEach((node, index) => {
      const angle = (index / count) * Math.PI * 2;
      output.set(
        node.id,
        new Vector3(Math.cos(angle) * radius, centerY + 0.15 * Math.sin(index), centerZ + Math.sin(angle) * 0.6)
      );
    });

    return output;
  }
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
