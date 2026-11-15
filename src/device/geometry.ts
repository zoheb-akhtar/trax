import type { CameraId, CameraView, Detection } from './types';

/**
 * Turns a detection box into a rough position around the bike, and back.
 *
 * World frame: the bike is at the origin, +x is the rider's right, -z is
 * straight ahead, +z is behind. Units are metres.
 *
 * Distance comes from box height and a typical real-world height for that kind
 * of object, so it is an estimate. The field-of-view numbers are for the
 * Raspberry Pi Camera Module 2 (IMX219) and need re-checking against the real
 * lens and any cropping the stream does.
 */

const H_FOV_DEG = 62.2;
const V_FOV_DEG = 48.8;
/** Focal lengths as a fraction of frame width / height. */
const FX = 0.5 / Math.tan((H_FOV_DEG * Math.PI) / 360);
const FY = 0.5 / Math.tan((V_FOV_DEG * Math.PI) / 360);
/** How high the camera sits above the road. Only used to place simulated boxes. */
const CAMERA_HEIGHT_M = 1.0;

const SIZES: Record<string, { height: number; width: number }> = {
  car: { height: 1.5, width: 1.8 },
  truck: { height: 3, width: 2.5 },
  bus: { height: 3, width: 2.5 },
  motorcycle: { height: 1.4, width: 0.8 },
  bicycle: { height: 1.6, width: 0.6 },
  person: { height: 1.7, width: 0.5 },
};
const DEFAULT_SIZE = { height: 1.5, width: 1 };

const VEHICLES = new Set(['car', 'truck', 'bus', 'motorcycle']);
/** A vehicle nearer than this, in the bike's lane or the next one over, is "close". */
export const CLOSE_DISTANCE_M = 7;
const CLOSE_LATERAL_M = 3.2;

export type WorldPosition = { x: number; z: number; distance: number };

/** Whether a detection was seen in this camera picture (for drawing its box over the video). */
export function seenIn(d: Detection, view: CameraView) {
  return d.view ? d.view === view : (d.camera ?? 'front') === view;
}

export function toWorld(d: Detection): WorldPosition {
  // The device measured it from the camera's mounting: better than guessing from the box.
  if (d.world) return d.world;
  const [bx, , bw, bh] = d.box;
  const size = SIZES[d.label] ?? DEFAULT_SIZE;
  const distance = Math.min(Math.max((size.height * FY) / Math.max(bh, 0.01), 0.5), 80);
  const lateral = ((bx + bw / 2 - 0.5) / FX) * distance;
  // The rear camera looks backwards, so its image is mirrored left-to-right.
  return d.camera === 'rear'
    ? { x: -lateral, z: distance, distance }
    : { x: lateral, z: -distance, distance };
}

/** The reverse of toWorld, used by the simulated device. Null if no camera can see it. */
export function toBox(
  label: string,
  x: number,
  z: number,
): { camera: CameraId; box: [number, number, number, number] } | null {
  const distance = Math.abs(z);
  if (distance < 1.2) return null; // alongside the bike: neither camera sees it
  const camera: CameraId = z < 0 ? 'front' : 'rear';
  const lateral = camera === 'rear' ? -x : x;
  const size = SIZES[label] ?? DEFAULT_SIZE;
  const h = (size.height * FY) / distance;
  const w = (size.width * FX) / distance;
  const cx = 0.5 + (lateral * FX) / distance;
  const cy = 0.5 + ((CAMERA_HEIGHT_M - size.height / 2) * FY) / distance;
  if (cx + w / 2 < 0 || cx - w / 2 > 1) return null; // out of frame
  return { camera, box: [cx - w / 2, cy - h / 2, w, h] };
}

export function isCyclist(d: Detection) {
  return d.label === 'bicycle';
}

/** A cyclist nearer than this, in or beside the bike lane, is worth a heads-up. */
const CYCLIST_NEAR_M = 10;

export function isNearCyclist(d: Detection) {
  if (!isCyclist(d)) return false;
  const p = toWorld(d);
  return p.distance < CYCLIST_NEAR_M && Math.abs(p.x) < 2.5;
}

/**
 * Object detectors usually report someone on a bike twice: once as "bicycle"
 * and once as "person". This drops the person when their box sits on a bicycle
 * box from the same camera, so each cyclist is one object.
 */
export function mergeCyclists(detections: Detection[]): Detection[] {
  const bikes = detections.filter(isCyclist);
  if (bikes.length === 0) return detections;
  return detections.filter((d) => {
    if (d.label !== 'person') return true;
    const [px, py, pw, ph] = d.box;
    const centreX = px + pw / 2;
    return !bikes.some((bike) => {
      if ((bike.camera ?? 'front') !== (d.camera ?? 'front')) return false;
      const [bx, by, bw, bh] = bike.box;
      const overlapsVertically = py < by + bh && py + ph > by;
      return centreX > bx && centreX < bx + bw && overlapsVertically;
    });
  });
}

/** While moving, only things that are close and not plainly visible to the rider are drawn. */
const RIDE_MODE_RANGE_M = 25;

export function mattersWhileRiding(d: Detection) {
  if (d.label === 'person') return isPedestrianAhead(d);
  return toWorld(d).distance < RIDE_MODE_RANGE_M;
}

/** A pedestrian only matters to a rider when close and in the way: ahead, near the bike's line. */
const PEDESTRIAN_AHEAD_M = 15;
const PEDESTRIAN_SIDE_M = 3;

export function isPedestrianAhead(d: Detection) {
  if (d.label !== 'person') return false;
  const p = toWorld(d);
  return p.z < 0 && p.distance < PEDESTRIAN_AHEAD_M && Math.abs(p.x) < PEDESTRIAN_SIDE_M;
}

export function isVehicle(d: Detection) {
  return VEHICLES.has(d.label);
}

export function isLargeVehicle(label: string) {
  return label === 'truck' || label === 'bus';
}

export function isCloseVehicle(d: Detection) {
  if (!isVehicle(d)) return false;
  const p = toWorld(d);
  return p.distance < CLOSE_DISTANCE_M && Math.abs(p.x) < CLOSE_LATERAL_M;
}
