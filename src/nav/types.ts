export type LatLon = { lat: number; lon: number };

export type Place = LatLon & {
  name: string;
  /** Street, city etc., for telling similar names apart */
  detail?: string;
  /** True when this place is a bike parking spot picked with "Park here" */
  isParking?: boolean;
};

export type TurnDirection =
  | 'depart'
  | 'straight'
  | 'slight-left'
  | 'left'
  | 'sharp-left'
  | 'slight-right'
  | 'right'
  | 'sharp-right'
  | 'uturn'
  | 'roundabout'
  | 'arrive';

export type Maneuver = {
  direction: TurnDirection;
  /** e.g. "Turn right onto Boylston Street." */
  instruction: string;
  street: string | null;
  /** Metres from the start of the route to where this happens */
  at: number;
};

export type Route = {
  points: LatLon[];
  /** Metres from the start to each point; same length as `points` */
  cumulative: number[];
  maneuvers: Maneuver[];
  /** Metres */
  distance: number;
  /** Seconds, as estimated by the router */
  duration: number;
  /** Whether it was planned to favour bike lanes and paths */
  bikeLanes: boolean;
};

export type Parking = LatLon & {
  id: string;
  /** OpenStreetMap's bicycle_parking type, e.g. "stands", "shed", "wall_loops" */
  kind: string | null;
  capacity: number | null;
  covered: boolean;
  /** True for parking you can lock a frame to, or that is sheltered or large */
  good: boolean;
  score: number;
  /** Metres from the destination */
  fromDestination: number;
};

export type Closure = {
  id: string;
  name: string | null;
  kind: 'construction' | 'closed';
  points: LatLon[];
};

export type RoadKind = 'major' | 'minor' | 'cycle' | 'foot';

/** A stretch of street, for drawing the ground in the 3D ride view. */
export type Road = {
  kind: RoadKind;
  points: LatLon[];
  name?: string;
  /** True for a road with a marked cycle lane or track */
  bikeLane?: boolean;
};

/** A park or a body of water, as an outline. */
export type Area = { kind: 'park' | 'water'; points: LatLon[] };

/** A building's outline and height, for the 3D ride view. */
export type Building = { points: LatLon[]; height: number };

export type Position = LatLon & {
  /** Degrees clockwise from north, when known */
  heading: number | null;
};

export type Progress = {
  /** Metres travelled along the route */
  along: number;
  /** Direction of travel, degrees clockwise from north: GPS course, else the route's direction here */
  heading: number;
  remaining: number;
  /** Seconds */
  remainingTime: number;
  /** The next turn, and how far away it is */
  next: Maneuver | null;
  distanceToNext: number;
  /** The turn after that */
  then: Maneuver | null;
  offRoute: boolean;
  /** Metres from the route */
  offBy: number;
  /** True while a new route is being planned from the current position */
  rerouting: boolean;
  arrived: boolean;
};
