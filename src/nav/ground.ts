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
  return { ...frame, route: toLine(route.points, frame), roads: byKind, buildings: blocks };
}

export function toPose(ground: Ground, position: LatLon, heading: number): Pose {
  return {
    east: (position.lon - ground.origin.lon) * ground.metresPerLon,
    north: (position.lat - ground.origin.lat) * ground.metresPerLat,
    heading,
  };
}
