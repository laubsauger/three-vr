/**
 * Convert lat/lon coordinates to local XY meters using an equirectangular
 * projection centered on the network's centroid. Good enough for a few km
 * radius (Bombay Beach scale).
 */

export interface LocalPoint {
  x: number; // East (meters)
  y: number; // Up (meters, from altitude)
  z: number; // North (meters)
}

export interface GeoCenter {
  lat: number;
  lon: number;
  alt: number;
}

const METERS_PER_DEGREE_LAT = 111_320;

export function computeCentroid(
  coords: Array<{ lat: number; lon: number; alt: number }>
): GeoCenter {
  let sumLat = 0;
  let sumLon = 0;
  let sumAlt = 0;
  for (const c of coords) {
    sumLat += c.lat;
    sumLon += c.lon;
    sumAlt += c.alt;
  }
  const n = coords.length || 1;
  return {
    lat: sumLat / n,
    lon: sumLon / n,
    alt: sumAlt / n,
  };
}

export function geoToLocal(
  lat: number,
  lon: number,
  alt: number,
  center: GeoCenter
): LocalPoint {
  const cosLat = Math.cos((center.lat * Math.PI) / 180);
  const metersPerDegreeLon = METERS_PER_DEGREE_LAT * cosLat;

  return {
    x: (lon - center.lon) * metersPerDegreeLon,
    y: alt - center.alt,
    z: (lat - center.lat) * METERS_PER_DEGREE_LAT,
  };
}

/**
 * Compute the bounding radius of a set of local points from the origin.
 */
export function computeBoundingRadius(points: LocalPoint[]): number {
  let maxR = 0;
  for (const p of points) {
    const r = Math.sqrt(p.x * p.x + p.z * p.z);
    if (r > maxR) maxR = r;
  }
  return maxR;
}
