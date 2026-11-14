import type { LatLon } from './types';

const EARTH_RADIUS_M = 6371000;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in metres. */
export function distance(a: LatLon, b: LatLon) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** Compass bearing from a to b, degrees clockwise from north. */
export function bearing(a: LatLon, b: LatLon) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Decodes an encoded polyline with 6 decimal places, as Valhalla returns. */
export function decodePolyline6(encoded: string): LatLon[] {
  const points: LatLon[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    lat += next();
    lon += next();
    points.push({ lat: lat / 1e6, lon: lon / 1e6 });
  }
  return points;
}

export function cumulativeDistances(points: LatLon[]) {
  const out = [0];
  for (let i = 1; i < points.length; i++) out.push(out[i - 1] + distance(points[i - 1], points[i]));
  return out;
}

/**
 * Finds the closest spot on a route to a position.
 * Returns how far along the route it is and how far off the route the position is, in metres.
 */
export function snapToRoute(points: LatLon[], cumulative: number[], position: LatLon) {
  // Near one spot the earth is flat enough to work in plain x/y metres.
  const metresPerLat = 111320;
  const metresPerLon = 111320 * Math.cos(rad(position.lat));
  let best = { along: 0, off: Infinity };

  for (let i = 0; i < points.length - 1; i++) {
    const ax = (points[i].lon - position.lon) * metresPerLon;
    const ay = (points[i].lat - position.lat) * metresPerLat;
    const bx = (points[i + 1].lon - position.lon) * metresPerLon;
    const by = (points[i + 1].lat - position.lat) * metresPerLat;
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq === 0 ? 0 : Math.min(Math.max(-(ax * dx + ay * dy) / lengthSq, 0), 1);
    const off = Math.hypot(ax + t * dx, ay + t * dy);
    if (off < best.off) {
      best = { along: cumulative[i] + t * (cumulative[i + 1] - cumulative[i]), off };
    }
  }
  if (points.length === 1) best = { along: 0, off: distance(points[0], position) };
  return best;
}

/** The point a given number of metres along a route, and the direction of travel there. */
export function pointAlong(points: LatLon[], cumulative: number[], along: number) {
  const clamped = Math.min(Math.max(along, 0), cumulative[cumulative.length - 1]);
  let i = 0;
  while (i < cumulative.length - 2 && cumulative[i + 1] < clamped) i++;
  const a = points[i];
  const b = points[Math.min(i + 1, points.length - 1)];
  const span = cumulative[Math.min(i + 1, cumulative.length - 1)] - cumulative[i];
  const t = span === 0 ? 0 : (clamped - cumulative[i]) / span;
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lon: a.lon + (b.lon - a.lon) * t,
    heading: bearing(a, b),
  };
}

/** Thins a route down to at most `max` evenly spaced points. */
export function sampleRoute(points: LatLon[], cumulative: number[], max: number) {
  const total = cumulative[cumulative.length - 1];
  const step = Math.max(total / (max - 1), 1);
  const out: LatLon[] = [];
  for (let along = 0; along < total; along += step) {
    const p = pointAlong(points, cumulative, along);
    out.push({ lat: p.lat, lon: p.lon });
  }
  out.push(points[points.length - 1]);
  return out;
}

export function formatDistance(metres: number) {
  if (metres < 1000) return `${Math.max(Math.round(metres / 10) * 10, 10)} m`;
  return `${(metres / 1000).toFixed(metres < 10000 ? 1 : 0)} km`;
}

export function formatDuration(seconds: number) {
  const minutes = Math.max(Math.round(seconds / 60), 1);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
