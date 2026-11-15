import { snapToRoute } from './geo';
import type { Area, Building, LatLon, Road, RoadKind, Route } from './types';

/**
 * Streets and the route, converted once into flat metres (east, north) from a
 * fixed origin, so the 3D ride view can redraw them every frame cheaply.
 */
export type GroundLine = {
  east: number[];
  north: number[];
  /** Bounding box, for skipping lines that are nowhere near the bike */
  minE: number;
  maxE: number;
  minN: number;
  maxN: number;
  /** Street name, for roads that have one */
  name?: string;
};

/** How pleasant a stretch of the route is to cycle: a bike lane or path, a quiet street, or a busy road. */
export type RouteClass = 'lane' | 'quiet' | 'busy';

export type Ground = {
  origin: LatLon;
  metresPerLat: number;
  metresPerLon: number;
  route: GroundLine;
  /** The route, run on a little past each end, for the lane drawn underneath it */
  routeBed: GroundLine;
  /** The route cut into stretches by how cycle-friendly the road is, for colouring it */
  routeRuns: Record<RouteClass, GroundLine[]>;
  roads: Record<RoadKind, GroundLine[]>;
  buildings: GroundBuilding[];
  areas: (GroundLine & { kind: Area['kind'] })[];
};

/** A building outline in metres, with its height and centre. */
export type GroundBuilding = GroundLine & {
  height: number;
  centreE: number;
  centreN: number;
  /** Whether the outline runs anticlockwise seen from above (east right, north up) */
  ccw: boolean;
};

export type Pose = { east: number; north: number; heading: number };

const METRES_PER_DEGREE = 111320;

function toLine(
  points: LatLon[],
  ground: Pick<Ground, 'origin' | 'metresPerLat' | 'metresPerLon'>,
) {
  const east = points.map((p) => (p.lon - ground.origin.lon) * ground.metresPerLon);
  const north = points.map((p) => (p.lat - ground.origin.lat) * ground.metresPerLat);
  return {
    east,
    north,
    minE: Math.min(...east),
    maxE: Math.max(...east),
    minN: Math.min(...north),
    maxN: Math.max(...north),
  };
}

export function buildGround(
  route: Route,
  roads: Road[],
  buildings: Building[] = [],
  areas: Area[] = [],
): Ground {
  const origin = route.points[0];
  const frame = {
    origin,
    metresPerLat: METRES_PER_DEGREE,
    metresPerLon: METRES_PER_DEGREE * Math.cos((origin.lat * Math.PI) / 180),
  };
  const byKind: Record<RoadKind, GroundLine[]> = {
    major: [],
    minor: [],
    cycle: [],
    foot: [],
  };
  for (const road of roads) {
    byKind[road.kind].push({ ...toLine(road.points, frame), name: road.name });
  }
  const blocks = buildings.map((building): GroundBuilding => {
    const line = toLine(building.points, frame);
    let doubleArea = 0;
    for (let i = 0; i < line.east.length; i++) {
      const j = (i + 1) % line.east.length;
      doubleArea += line.east[i] * line.north[j] - line.east[j] * line.north[i];
    }
    return {
      ...line,
      height: building.height,
      centreE: (line.minE + line.maxE) / 2,
      centreN: (line.minN + line.maxN) / 2,
      ccw: doubleArea > 0,
    };
  });
  return {
    ...frame,
    route: toLine(route.points, frame),
    routeBed: toLine(extended(route.points), frame),
    routeRuns: routeRuns(route, roads, frame),
    roads: byKind,
    buildings: blocks,
    areas: areas.map((area) => ({ ...toLine(area.points, frame), kind: area.kind })),
  };
}

export function toPose(ground: Ground, position: LatLon, heading: number): Pose {
  return {
    east: (position.lon - ground.origin.lon) * ground.metresPerLon,
    north: (position.lat - ground.origin.lat) * ground.metresPerLat,
    heading,
  };
}

/** The points with one more added at each end, continuing straight on for about 25 m. */
function extended(points: LatLon[]): LatLon[] {
  if (points.length < 2) return points;
  const beyond = (end: LatLon, before: LatLon): LatLon => {
    const dLat = end.lat - before.lat;
    const dLon = (end.lon - before.lon) * Math.cos((end.lat * Math.PI) / 180);
    const metres = Math.hypot(dLat, dLon) * METRES_PER_DEGREE || 1;
    const scale = 25 / metres;
    return {
      lat: end.lat + (end.lat - before.lat) * scale,
      lon: end.lon + (end.lon - before.lon) * scale,
    };
  };
  const last = points.length - 1;
  return [beyond(points[0], points[1]), ...points, beyond(points[last], points[last - 1])];
}

/** A route point within this many metres of a road is taken to be on it. */
const ON_ROAD_M = 14;

/**
 * Says, for each stretch between route points, how cycle-friendly the road under it is.
 * Before the street data has loaded every stretch is 'quiet'.
 */
export function classifyRoute(route: Route, roads: Road[]): RouteClass[] {
  const classes: RouteClass[] = [];
  // Roads as boxes first, so most are ruled out without measuring.
  const boxed = roads.map((road) => {
    const lats = road.points.map((p) => p.lat);
    const lons = road.points.map((p) => p.lon);
    const cumulative = road.points.map(() => 0);
    return {
      road,
      cumulative,
      south: Math.min(...lats) - 0.0002,
      north: Math.max(...lats) + 0.0002,
      west: Math.min(...lons) - 0.0003,
      east: Math.max(...lons) + 0.0003,
    };
  });
  for (let i = 0; i < route.points.length - 1; i++) {
    const a = route.points[i];
    const b = route.points[i + 1];
    const mid = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
    let best: Road | null = null;
    let bestOff = ON_ROAD_M;
    for (const item of boxed) {
      if (
        mid.lat < item.south ||
        mid.lat > item.north ||
        mid.lon < item.west ||
        mid.lon > item.east
      ) {
        continue;
      }
      const off = snapToRoute(item.road.points, item.cumulative, mid).off;
      // Between two candidates at the same spot, prefer the one with the bike lane.
      if (off < bestOff - 2 || (off < bestOff + 2 && item.road.bikeLane && !best?.bikeLane)) {
        best = item.road;
        bestOff = Math.min(off, bestOff);
      }
    }
    if (!best) classes.push('quiet');
    else if (best.kind === 'cycle' || best.kind === 'foot' || best.bikeLane) classes.push('lane');
    else classes.push(best.kind === 'major' ? 'busy' : 'quiet');
  }
  return classes;
}

/** The share of the route's length, 0-1, that is on a bike lane or path. */
export function bikeLaneShare(route: Route, roads: Road[]) {
  if (roads.length === 0 || route.distance === 0) return null;
  const classes = classifyRoute(route, roads);
  let onLane = 0;
  classes.forEach((c, i) => {
    if (c === 'lane') onLane += route.cumulative[i + 1] - route.cumulative[i];
  });
  return onLane / route.distance;
}

function routeRuns(
  route: Route,
  roads: Road[],
  frame: Pick<Ground, 'origin' | 'metresPerLat' | 'metresPerLon'>,
): Record<RouteClass, GroundLine[]> {
  const runs: Record<RouteClass, GroundLine[]> = { lane: [], quiet: [], busy: [] };
  const classes = classifyRoute(route, roads);
  let start = 0;
  for (let i = 1; i <= classes.length; i++) {
    if (i === classes.length || classes[i] !== classes[start]) {
      runs[classes[start]].push(toLine(route.points.slice(start, i + 1), frame));
      start = i;
    }
  }
  return runs;
}
