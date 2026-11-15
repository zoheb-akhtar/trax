/**
 * Free services built on OpenStreetMap data. None needs an account or key;
 * all are shared community servers, so keep requests modest.
 *
 *  - Photon (komoot): place search as you type
 *  - Valhalla (FOSSGIS): bicycle routing with turn-by-turn instructions
 *  - Overpass: raw map data, used here for bike parking and closed roads
 */
import { cumulativeDistances, decodePolyline6, distance, snapToRoute } from './geo';
import type {
  Area,
  Building,
  Closure,
  LatLon,
  Maneuver,
  Parking,
  Place,
  Road,
  RoadKind,
  Route,
  TurnDirection,
} from './types';

const PHOTON = 'https://photon.komoot.io/api/';
const VALHALLA = 'https://valhalla1.openstreetmap.de/route';
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
/**
 * These servers are shared and often queue requests for half a minute, so each
 * gets a generous wait before the next is tried.
 */
const OVERPASS_TIMEOUT_MS = 60000;
const OVERPASS_ROUNDS = 1;

/**
 * The community servers turn away clients that don't say what they are.
 * (Browsers ignore this header and send their own.)
 */
const IDENTIFY = { 'User-Agent': 'VeloBikeApp/0.1 (hackathon prototype)' };
export const MAP_REQUEST_HEADERS = IDENTIFY;

const BIKES_ALLOWED = new Set(['yes', 'designated', 'permissive']);
/** Searches and route plans give up after this long, rather than spinning on bad Wi-Fi. */
const SEARCH_TIMEOUT_MS = 8000;
const ROUTE_TIMEOUT_MS = 15000;

/** A signal that aborts when `outer` does, or after `ms`. */
function withTimeout(ms: number, outer?: AbortSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), ms);
  outer?.addEventListener('abort', () => controller.abort(outer.reason));
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/** A failed request explained in words a rider understands. */
function networkProblem(error: unknown, what: string): Error {
  if (error instanceof Error && /network request failed|timeout|aborted/i.test(error.message)) {
    return new Error(`No internet connection, or the ${what} service is slow. Try again.`);
  }
  return error instanceof Error ? error : new Error(`The ${what} service failed.`);
}

// ---- Place search -----------------------------------------------------------------

export async function searchPlaces(
  query: string,
  near: LatLon | null,
  signal?: AbortSignal,
): Promise<Place[]> {
  const params = new URLSearchParams({ q: query, limit: '6' });
  if (near) {
    params.set('lat', String(near.lat));
    params.set('lon', String(near.lon));
  }
  const limit = withTimeout(SEARCH_TIMEOUT_MS, signal);
  let res: Response;
  try {
    res = await fetch(`${PHOTON}?${params}`, { signal: limit.signal, headers: IDENTIFY });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw networkProblem(error, 'search');
  } finally {
    limit.done();
  }
  if (!res.ok) throw new Error(`Search is unavailable right now (${res.status}).`);
  const json = await res.json();

  const places: Place[] = (json.features ?? []).map((f: any): Place => {
    const p = f.properties ?? {};
    const street = [p.housenumber, p.street].filter(Boolean).join(' ');
    const name = p.name || street || p.city || 'Unnamed place';
    const detail = [p.name ? street : null, p.city, p.state]
      .filter((part) => part && part !== name)
      .join(', ');
    return { name, detail, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] };
  });
  // The same place is often in the map twice (as a point and as a building outline).
  const seen = new Set<string>();
  return places.filter((place) => {
    const key = `${place.name}|${place.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A short name for a spot, such as its street. Null if nothing is found. */
export async function placeName(at: LatLon, signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch(`${PHOTON.replace(/api\/$/, 'reverse')}?lat=${at.lat}&lon=${at.lon}`, {
      signal,
      headers: IDENTIFY,
    });
    if (!res.ok) return null;
    const p = (await res.json()).features?.[0]?.properties ?? {};
    const street = [p.housenumber, p.street].filter(Boolean).join(' ');
    return [p.name, street || null].filter(Boolean)[0] ?? p.city ?? null;
  } catch {
    return null;
  }
}

// ---- Bicycle routing ----------------------------------------------------------------

/** Valhalla's numeric maneuver types, reduced to what the turn arrow needs. */
function direction(type: number): TurnDirection {
  switch (type) {
    case 1:
    case 2:
    case 3:
      return 'depart';
    case 4:
    case 5:
    case 6:
      return 'arrive';
    case 9:
    case 23:
    case 37:
      return 'slight-right';
    case 10:
    case 18:
    case 20:
      return 'right';
    case 11:
      return 'sharp-right';
    case 12:
    case 13:
      return 'uturn';
    case 14:
      return 'sharp-left';
    case 15:
    case 19:
    case 21:
      return 'left';
    case 16:
    case 24:
    case 38:
      return 'slight-left';
    case 26:
    case 27:
      return 'roundabout';
    default:
      return 'straight';
  }
}

/**
 * Plans a cycling route. With `bikeLanes` on, the router is told to strongly
 * avoid sharing roads with cars, which pulls the route onto bike lanes and
 * paths even when that is longer.
 */
export async function fetchRoute(
  from: LatLon,
  to: LatLon,
  bikeLanes: boolean,
  signal?: AbortSignal,
): Promise<Route> {
  const limit = withTimeout(ROUTE_TIMEOUT_MS, signal);
  const res = await fetch(VALHALLA, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...IDENTIFY },
    signal: limit.signal,
    body: JSON.stringify({
      locations: [
        { lat: from.lat, lon: from.lon },
        { lat: to.lat, lon: to.lon },
      ],
      costing: 'bicycle',
      costing_options: {
        bicycle: { bicycle_type: 'Hybrid', use_roads: bikeLanes ? 0.15 : 0.6 },
      },
      directions_options: { units: 'kilometers' },
    }),
  })
    .catch((error) => {
      if (signal?.aborted) throw error;
      throw networkProblem(error, 'routing');
    })
    .finally(() => limit.done());
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.trip?.legs?.length) {
    const reason = String(json?.error ?? '');
    // The routing service's own wording for a trip of more than 150 km.
    if (/max distance/i.test(reason)) {
      throw new Error('That is too far to cycle. Pick somewhere closer.');
    }
    throw new Error(reason || `No cycling route found (${res.status})`);
  }

  const leg = json.trip.legs[0];
  const points = decodePolyline6(leg.shape);
  const cumulative = cumulativeDistances(points);
  const maneuvers: Maneuver[] = leg.maneuvers.map((m: any) => ({
    direction: direction(m.type),
    instruction: m.instruction,
    street: m.street_names?.[0] ?? null,
    at: cumulative[Math.min(m.begin_shape_index, cumulative.length - 1)],
  }));

  return {
    points,
    cumulative,
    maneuvers,
    distance: cumulative[cumulative.length - 1],
    duration: json.trip.summary.time,
    bikeLanes,
  };
}

// ---- Bike parking and closed roads ---------------------------------------------------

const GOOD_PARKING = new Set([
  'stands',
  'wide_stands',
  'safe_loops',
  'lockers',
  'shed',
  'building',
]);
const POOR_PARKING = new Set(['wall_loops', 'ground_slots', 'anchors', 'rack']);
const SHELTERED = new Set(['shed', 'building', 'lockers']);
/** Roads a cyclist would actually use; "access=no" on a driveway is not a closure. */
const THROUGH_ROADS = new Set([
  'primary',
  'secondary',
  'tertiary',
  'unclassified',
  'residential',
  'living_street',
  'cycleway',
]);

/** Streets drawn on the ground of the 3D ride view. */
const ROAD_KIND: Record<string, RoadKind> = {
  trunk: 'major',
  primary: 'major',
  secondary: 'major',
  tertiary: 'minor',
  unclassified: 'minor',
  residential: 'minor',
  living_street: 'minor',
  service: 'minor',
  cycleway: 'cycle',
  pedestrian: 'foot',
  footway: 'foot',
  path: 'foot',
};
/** Pavements beside a road, crossings and driveways would only clutter the view. */
const SKIP_FOOTWAY = new Set(['sidewalk', 'crossing', 'traffic_island']);
const SKIP_SERVICE = new Set(['parking_aisle', 'driveway', 'drive-through']);
const ROAD_CLASSES = Object.keys(ROAD_KIND).join('|');
/** How OpenStreetMap marks a cycle lane or track that is part of a road. */
const BIKE_LANE_TAGS = ['cycleway', 'cycleway:left', 'cycleway:right', 'cycleway:both'];
const BIKE_LANE_VALUES = new Set([
  'lane',
  'track',
  'opposite_lane',
  'opposite_track',
  'buffered_lane',
]);

const PARKING_NEAR_ROUTE_M = 60;
const PARKING_NEAR_DESTINATION_M = 350;

function centre(element: any): LatLon | null {
  if (typeof element.lat === 'number') return { lat: element.lat, lon: element.lon };
  const geometry: LatLon[] | undefined = element.geometry;
  if (!geometry?.length) return null;
  return {
    lat: geometry.reduce((sum, p) => sum + p.lat, 0) / geometry.length,
    lon: geometry.reduce((sum, p) => sum + p.lon, 0) / geometry.length,
  };
}

function toParking(element: any, destination: LatLon): Parking | null {
  const tags = element.tags ?? {};
  if (tags.access === 'private' || tags.access === 'no') return null;
  const at = centre(element);
  if (!at) return null;

  const kind: string | null = tags.bicycle_parking ?? null;
  const capacity = Number.parseInt(tags.capacity, 10);
  const covered = tags.covered === 'yes' || (kind != null && SHELTERED.has(kind));

  let score = 0;
  if (kind && GOOD_PARKING.has(kind)) score += 3;
  if (kind === 'bollard') score += 1;
  if (kind && POOR_PARKING.has(kind)) score -= 2;
  if (covered) score += 2;
  if (Number.isFinite(capacity)) score += Math.min(capacity, 20) / 10;
  if (tags.lit === 'yes' || tags.supervised === 'yes' || tags.surveillance) score += 1;
  if (tags.access === 'customers') score -= 2;

  return {
    id: `${element.type}/${element.id}`,
    ...at,
    kind,
    capacity: Number.isFinite(capacity) ? capacity : null,
    covered,
    good: score >= 3,
    score,
    fromDestination: distance(at, destination),
  };
}

/** A row of bollards is often mapped as many separate points; treat it as one place. */
function mergeNearby(all: Parking[]): Parking[] {
  const merged: Parking[] = [];
  for (const p of [...all].sort((a, b) => b.score - a.score)) {
    const near = merged.find((m) => distance(m, p) < 25);
    if (!near) {
      merged.push({ ...p });
      continue;
    }
    if (p.capacity != null) near.capacity = (near.capacity ?? 0) + p.capacity;
    if (near.capacity != null && near.capacity >= 10 && near.score >= 2) near.good = true;
  }
  return merged;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs a map-data query, trying each server in turn and going round again if all are busy. */
async function overpass(query: string, signal?: AbortSignal): Promise<any> {
  let lastError: unknown = new Error('Map data request failed');
  for (let round = 0; round < OVERPASS_ROUNDS; round++) {
    if (round > 0) await wait(4000);
    for (const url of OVERPASS) {
      // One controller per try, so a slow server can be abandoned without cancelling the caller.
      const attempt = new AbortController();
      const cancel = () => attempt.abort();
      signal?.addEventListener('abort', cancel);
      const timer = setTimeout(cancel, OVERPASS_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...IDENTIFY },
          body: `data=${encodeURIComponent(query)}`,
          signal: attempt.signal,
        });
        if (!res.ok) throw new Error(`Map data server busy (${res.status})`);
        return await res.json();
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
      }
    }
  }
  throw lastError;
}

export async function fetchAlongRoute(
  route: Route,
  signal?: AbortSignal,
): Promise<{ parking: Parking[]; closures: Closure[]; roads: Road[] }> {
  const destination = route.points[route.points.length - 1];

  // Ask for everything in the box around the route and filter here: far quicker
  // for the server than asking "what is within N metres of this line".
  const margin = 0.004; // about 400 m
  const lats = route.points.map((p) => p.lat);
  const lons = route.points.map((p) => p.lon);
  const box = [
    Math.min(...lats) - margin,
    Math.min(...lons) - margin,
    Math.max(...lats) + margin,
    Math.max(...lons) + margin,
  ]
    .map((n) => n.toFixed(5))
    .join(',');
  const query = `[out:json][timeout:25];(
    nwr["amenity"="bicycle_parking"](${box});
    way["highway"="construction"](${box});
    way["highway"]["access"="no"](${box});
    way["highway"~"^(${ROAD_CLASSES})(_link)?$"](${box});
  );out geom 30000;`;

  const json = await overpass(query, signal);

  const parking: Parking[] = [];
  const closures: Closure[] = [];
  const roads: Road[] = [];
  for (const element of json.elements ?? []) {
    const tags = element.tags ?? {};
    const roadKind = ROAD_KIND[String(tags.highway ?? '').replace(/_link$/, '')];
    const clutter = SKIP_FOOTWAY.has(tags.footway) || SKIP_SERVICE.has(tags.service);
    if (element.type === 'way' && roadKind && !clutter && element.geometry?.length > 1) {
      roads.push({
        kind: roadKind,
        points: element.geometry.map((g: any) => ({ lat: g.lat, lon: g.lon })),
        name: tags.name,
        bikeLane: BIKE_LANE_TAGS.some((tag) => BIKE_LANE_VALUES.has(tags[tag])),
      });
      if (tags.access !== 'no') continue; // an open street; closed ones fall through below
    }
    if (tags.amenity === 'bicycle_parking') {
      const p = toParking(element, destination);
      if (!p) continue;
      const nearDestination = p.fromDestination <= PARKING_NEAR_DESTINATION_M;
      const nearRoute = snapToRoute(route.points, route.cumulative, p).off <= PARKING_NEAR_ROUTE_M;
      if (nearDestination || nearRoute) parking.push(p);
    } else if (element.type === 'way' && element.geometry?.length > 1) {
      const construction = tags.highway === 'construction';
      if (!construction && !THROUGH_ROADS.has(tags.highway)) continue;
      // Closed to cars but open to bikes (a cycle street, a pedestrian zone) is no closure for us.
      if (!construction && BIKES_ALLOWED.has(tags.bicycle)) continue;
      const points: LatLon[] = element.geometry.map((g: any) => ({ lat: g.lat, lon: g.lon }));
      // Only keep ones that really touch the route, not a parallel street.
      const mid = points[Math.floor(points.length / 2)];
      if (snapToRoute(route.points, route.cumulative, mid).off > 80) continue;
      closures.push({
        id: `way/${element.id}`,
        name: tags.name ?? null,
        kind: construction ? 'construction' : 'closed',
        points,
      });
    }
  }

  return {
    parking: mergeNearby(parking).sort(
      (a, b) => Number(b.good) - Number(a.good) || a.fromDestination - b.fromDestination,
    ),
    closures,
    roads,
  };
}

// ---- Buildings ---------------------------------------------------------------------

/** Buildings further than this from the route never come into the ride view. */
const BUILDINGS_NEAR_ROUTE_M = 110;
const METRES_PER_LEVEL = 3.2;
const DEFAULT_HEIGHT_M = 9;

/**
 * Building outlines, parks and water along the route, for the 3D ride view. A separate request
 * from streets and parking because a city has thousands of them.
 */
export async function fetchScenery(
  route: Route,
  signal?: AbortSignal,
): Promise<{ buildings: Building[]; areas: Area[] }> {
  const margin = 0.0015; // about 150 m
  const lats = route.points.map((p) => p.lat);
  const lons = route.points.map((p) => p.lon);
  const box = [
    Math.min(...lats) - margin,
    Math.min(...lons) - margin,
    Math.max(...lats) + margin,
    Math.max(...lons) + margin,
  ]
    .map((n) => n.toFixed(5))
    .join(',');
  const json = await overpass(
    `[out:json][timeout:25];(
      way["building"](${box});
      way["leisure"~"^(park|garden|pitch|playground)$"](${box});
      way["landuse"~"^(grass|recreation_ground|village_green)$"](${box});
      way["natural"="water"](${box});
    );out tags geom 30000;`,
    signal,
  );

  const buildings: Building[] = [];
  const areas: Area[] = [];
  for (const element of json.elements ?? []) {
    const geometry: LatLon[] | undefined = element.geometry;
    if (!geometry || geometry.length < 4) continue;
    if (!element.tags?.building) {
      // A park or water: keep it if any part of it comes near the route.
      const near = geometry.some(
        (g, i) => i % 3 === 0 && snapToRoute(route.points, route.cumulative, g).off < 160,
      );
      if (near) {
        areas.push({
          kind: element.tags?.natural === 'water' ? 'water' : 'park',
          points: geometry.slice(0, -1).map((g) => ({ lat: g.lat, lon: g.lon })),
        });
      }
      continue;
    }
    const mid = centre(element);
    if (!mid || snapToRoute(route.points, route.cumulative, mid).off > BUILDINGS_NEAR_ROUTE_M) {
      continue;
    }
    const tags = element.tags ?? {};
    const height =
      Number.parseFloat(tags.height) ||
      Number.parseFloat(tags['building:levels']) * METRES_PER_LEVEL ||
      DEFAULT_HEIGHT_M;
    // Outlines repeat their first point at the end; drop the repeat.
    const points = geometry.slice(0, -1).map((g) => ({ lat: g.lat, lon: g.lon }));
    buildings.push({ points, height });
  }
  return { buildings, areas };
}
