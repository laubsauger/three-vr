export type NodeType = "tower" | "backhaul" | "router" | "switch" | "client" | "unknown";

export type LinkMedium = "wired" | "wireless" | "fiber" | "unknown";

export type HealthState = "up" | "degraded" | "down" | "unknown";

export interface MetricSnapshot {
  status: HealthState;
  rssi?: number;
  snr?: number;
  throughputMbps?: number;
  latencyMs?: number;
  packetLossPct?: number;
  utilizationPct?: number;
  updatedAtMs: number;
}

export interface InfraNode {
  id: string;
  markerId: number;
  type: NodeType;
  label: string;
  metrics: MetricSnapshot;
}

export interface InfraLink {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  medium: LinkMedium;
  metrics: MetricSnapshot;
}

export interface TopologySnapshot {
  nodes: InfraNode[];
  links: InfraLink[];
  generatedAtMs: number;
}

export interface NodeMetricUpdate {
  nodeId: string;
  metrics: Partial<MetricSnapshot>;
}

export interface LinkMetricUpdate {
  linkId: string;
  metrics: Partial<MetricSnapshot>;
}

export interface Vector3Like {
  x: number;
  y: number;
  z: number;
}

export interface QuaternionLike {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface AnchorPose {
  position: Vector3Like;
  rotation: QuaternionLike;
  confidence: number;
  lastSeenAtMs: number;
}

export interface TrackedMarker {
  markerId: number;
  pose: AnchorPose;
  sizeMeters?: number;
}

export type Handedness = "left" | "right";

export interface HandJoint {
  name: string;
  position: Vector3Like;
  radius: number;
}

export interface HandData {
  hand: Handedness;
  joints: HandJoint[];
  pinching: boolean;
  pinchStrength: number;
  /** Midpoint between thumb tip and index tip. */
  pinchPoint: Vector3Like;
}
