/**
 * Renders a KML network as a miniature 3D map anchored to a detected
 * ArUco marker. The entire network is scaled to fit ~0.5m across so it
 * appears as a tabletop overlay.
 */

import {
  BufferGeometry,
  CanvasTexture,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
} from "three";

import type { KmlNetwork } from "./parser";
import type { GeoCenter, LocalPoint } from "./geo-projection";
import { computeBoundingRadius, computeCentroid, geoToLocal } from "./geo-projection";

export interface KmlMapRendererOptions {
  /** Target physical size of the map in meters. Default 0.5. */
  mapSizeMeters?: number;
  /** Vertical offset above the marker surface. Default 0.02. */
  hoverOffsetMeters?: number;
}

interface SiteMesh {
  name: string;
  sphere: Mesh<SphereGeometry, MeshStandardMaterial>;
  label: Sprite;
  localPos: LocalPoint;
}

export class KmlMapRenderer {
  private readonly root = new Group();
  private readonly siteGroup = new Group();
  private readonly linkGroup = new Group();
  private readonly mapSizeMeters: number;
  private readonly hoverOffsetMeters: number;
  private siteMeshes: SiteMesh[] = [];
  private scale = 1;
  private center: GeoCenter = { lat: 0, lon: 0, alt: 0 };
  private loaded = false;

  constructor(options: KmlMapRendererOptions = {}) {
    this.mapSizeMeters = options.mapSizeMeters ?? 1.2;
    this.hoverOffsetMeters = options.hoverOffsetMeters ?? 0.02;
    this.root.name = "kml-map";
    this.root.add(this.siteGroup, this.linkGroup);
    this.root.visible = false;
  }

  getRoot(): Group {
    return this.root;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Build the 3D map from parsed KML data.
   */
  loadNetwork(network: KmlNetwork): void {
    this.dispose();

    const allCoords = network.sites.map((s) => ({
      lat: s.lat,
      lon: s.lon,
      alt: s.alt,
    }));
    if (allCoords.length === 0) return;

    this.center = computeCentroid(allCoords);

    const localSites = network.sites.map((site) => ({
      site,
      local: geoToLocal(site.lat, site.lon, site.alt, this.center),
    }));

    const localPoints = localSites.map((s) => s.local);
    const radius = computeBoundingRadius(localPoints);
    this.scale = radius > 0.01 ? (this.mapSizeMeters / 2) / radius : 1;

    for (const { site, local } of localSites) {
      const color = selectSiteColor(site.name);
      const sphereRadius = isTower(site.name) ? 0.008 : 0.005;

      const sphere = new Mesh(
        new SphereGeometry(sphereRadius, 12, 8),
        new MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: 0.4,
          roughness: 0.3,
          metalness: 0.1,
        })
      );

      const x = local.x * this.scale;
      const y = this.hoverOffsetMeters + local.y * this.scale * 0.01;
      const z = local.z * this.scale;
      sphere.position.set(x, y, z);
      sphere.name = `kml-site-${site.name}`;

      const label = createTextSprite(shortenName(site.name), color);
      label.position.set(x, y + 0.012, z);
      label.scale.set(0.04, 0.01, 1);

      this.siteGroup.add(sphere, label);
      this.siteMeshes.push({ name: site.name, sphere, label, localPos: local });
    }

    for (const link of network.links) {
      if (link.points.length < 2) continue;

      const positions: number[] = [];
      for (const pt of link.points) {
        const local = geoToLocal(pt.lat, pt.lon, pt.alt, this.center);
        positions.push(
          local.x * this.scale,
          this.hoverOffsetMeters + local.y * this.scale * 0.01,
          local.z * this.scale
        );
      }

      const geometry = new BufferGeometry();
      geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));

      const linkColor = selectLinkColor(link.name);
      const line = new Line(
        geometry,
        new LineBasicMaterial({
          color: linkColor,
          transparent: true,
          opacity: 0.7,
        })
      );
      line.name = `kml-link-${link.name}`;
      this.linkGroup.add(line);
    }

    this.loaded = true;
  }

  /**
   * Anchor the map to a marker's detected position and rotation.
   */
  anchorToMarker(position: Vector3, rotation: Quaternion): void {
    this.root.position.copy(position);
    this.root.position.y += this.hoverOffsetMeters;
    this.root.quaternion.copy(rotation);
    this.root.visible = true;
  }

  hide(): void {
    this.root.visible = false;
  }

  dispose(): void {
    for (const sm of this.siteMeshes) {
      sm.sphere.geometry.dispose();
      sm.sphere.material.dispose();
      if (sm.label.material instanceof SpriteMaterial) {
        sm.label.material.map?.dispose();
        sm.label.material.dispose();
      }
    }
    this.siteMeshes = [];

    for (let i = this.linkGroup.children.length - 1; i >= 0; i--) {
      const child = this.linkGroup.children[i] as Line;
      child.geometry.dispose();
      (child.material as LineBasicMaterial).dispose();
      this.linkGroup.remove(child);
    }
    for (let i = this.siteGroup.children.length - 1; i >= 0; i--) {
      this.siteGroup.remove(this.siteGroup.children[i]);
    }

    this.loaded = false;
  }
}

// ---- Helpers ----

function isTower(name: string): boolean {
  return /^(chowtower|venus|mars|tao|neocity)$/i.test(name.split("-")[0]);
}

function selectSiteColor(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("chowtower")) return "#ff6644";
  if (lower.includes("venus")) return "#ffaa22";
  if (lower.includes("mars")) return "#ff4466";
  if (lower.includes("neocity")) return "#44bbff";
  if (lower.includes("tao")) return "#88dd44";
  return "#aaccdd";
}

function selectLinkColor(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("ptp")) return "#ffcc33";
  if (lower.includes("sector")) return "#33aaff";
  if (lower.includes("line of sight")) return "#33ff88";
  return "#6699bb";
}

function shortenName(name: string): string {
  return name
    .replace(/-rf-/g, " ")
    .replace(/sector-/g, "s-")
    .replace(/ptp-/g, "\u2192")
    .replace(/st-/g, "st ")
    .replace(/:[0-9a-fA-F]{2}$/i, "")
    .slice(0, 18);
}

function createTextSprite(text: string, color: string): Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "rgba(8, 16, 20, 0.75)";
    ctx.fillRect(0, 0, 256, 64);
    ctx.font = "bold 28px monospace";
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 128, 32);
  }

  const texture = new CanvasTexture(canvas);
  const material = new SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
  });
  return new Sprite(material);
}
