import type { Building, LatLon, Road, RoadKind, Route } from './types';

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
};

export type Ground = {
  origin: LatLon;
  metresPerLat: number;
  metresPerLon: number;
  route: GroundLine;
  /** The route, run on a little past each end, for the lane drawn underneath it */
  routeBed: GroundLine;
  roads: Record<RoadKind, GroundLine[]>;
  buildings: GroundBuilding[];
};

/** A building outline in metres, with its height and centre. */
export type GroundBuilding = GroundLine & { height: number; centreE: number; centreN: number };

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

export function buildGround(route: Route, roads: Road[], buildings: Building[] = []): Ground {
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
  for (const road of roads) byKind[road.kind].push(toLine(road.points, frame));
  const blocks = buildings.map((building): GroundBuilding => {
    const line = toLine(building.points, frame);
    return {
      ...line,
      height: building.height,
      centreE: (line.minE + line.maxE) / 2,
      centreN: (line.minN + line.maxN) / 2,
    };
  });
  return {
    ...frame,
    route: toLine(route.points, frame),
    routeBed: toLine(extended(route.points), frame),
    roads: byKind,
    buildings: blocks,
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
