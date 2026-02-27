/**
 * KML parser for UISP Design Center network topology exports.
 * Extracts site Placemarks (Points) and link Placemarks (LineStrings).
 */

export interface KmlSite {
  id: string;
  name: string;
  description: string;
  lat: number;
  lon: number;
  alt: number;
}

export interface KmlLink {
  id: string;
  name: string;
  points: Array<{ lat: number; lon: number; alt: number }>;
}

export interface KmlNetwork {
  name: string;
  sites: KmlSite[];
  links: KmlLink[];
}

/**
 * Parse a KML string into sites and links.
 * Sites = Placemarks containing a <Point>.
 * Links = Placemarks containing a <LineString> whose name is NOT a
 * height label (e.g., "10 m", "-5 m") and NOT "axisLabels".
 */
export function parseKml(kmlText: string): KmlNetwork {
  const parser = new DOMParser();
  const doc = parser.parseFromString(kmlText, "application/xml");

  const ns = "http://www.opengis.net/kml/2.2";
  const docName =
    doc.getElementsByTagNameNS(ns, "Document")[0]
      ?.getElementsByTagNameNS(ns, "name")[0]?.textContent ?? "unknown";

  const sites: KmlSite[] = [];
  const links: KmlLink[] = [];

  const placemarks = doc.getElementsByTagNameNS(ns, "Placemark");

  for (let i = 0; i < placemarks.length; i++) {
    const pm = placemarks[i];
    const name = pm.getElementsByTagNameNS(ns, "name")[0]?.textContent ?? "";
    const desc = pm.getElementsByTagNameNS(ns, "description")[0]?.textContent ?? "";

    // Skip height labels and axis labels
    if (isHeightLabel(name)) continue;

    const point = pm.getElementsByTagNameNS(ns, "Point")[0];
    if (point) {
      const coords = point.getElementsByTagNameNS(ns, "coordinates")[0]?.textContent?.trim();
      if (coords) {
        const parsed = parseCoordinate(coords);
        if (parsed) {
          sites.push({
            id: pm.getAttribute("id") ?? `site-${i}`,
            name,
            description: desc,
            lat: parsed.lat,
            lon: parsed.lon,
            alt: parsed.alt,
          });
        }
      }
      continue;
    }

    const lineString = pm.getElementsByTagNameNS(ns, "LineString")[0];
    if (lineString) {
      const coords = lineString.getElementsByTagNameNS(ns, "coordinates")[0]?.textContent?.trim();
      if (coords) {
        const points = parseCoordinateList(coords);
        if (points.length >= 2) {
          // Only include if it looks like a real link (connects two distinct points)
          const first = points[0];
          const last = points[points.length - 1];
          const dist = Math.hypot(first.lat - last.lat, first.lon - last.lon);
          if (dist > 0.00001) {
            links.push({
              id: pm.getAttribute("id") ?? `link-${i}`,
              name,
              points,
            });
          }
        }
      }
    }
  }

  // Deduplicate sites by name (UISP often has multiple placemarks per site)
  const uniqueSites = deduplicateSites(sites);

  return { name: docName, sites: uniqueSites, links };
}

function isHeightLabel(name: string): boolean {
  return /^-?\d+\s*m$/.test(name.trim()) || name.trim() === "axisLabels";
}

function parseCoordinate(text: string): { lat: number; lon: number; alt: number } | null {
  const parts = text.split(",").map((s) => parseFloat(s.trim()));
  if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) return null;
  return {
    lon: parts[0],
    lat: parts[1],
    alt: parts.length >= 3 && !isNaN(parts[2]) ? parts[2] : 0,
  };
}

function parseCoordinateList(text: string): Array<{ lat: number; lon: number; alt: number }> {
  return text
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(parseCoordinate)
    .filter((c): c is NonNullable<typeof c> => c !== null);
}

function deduplicateSites(sites: KmlSite[]): KmlSite[] {
  const seen = new Map<string, KmlSite>();
  for (const site of sites) {
    if (!seen.has(site.name)) {
      seen.set(site.name, site);
    }
  }
  return Array.from(seen.values());
}
