import type { Ride, RideMoment } from './ride-history';

/**
 * A believable week of rides around Back Bay, Boston, for showing the app before anyone has
 * ridden with it. Loaded from the Device tab; real rides are recorded the same way as ever.
 */

type Point = [number, number]; // [lat, lon]

const SYMPHONY: Point = [42.343, -71.0858];
const MASS_AND_BOYLSTON: Point = [42.3478, -71.0876];
const LIBRARY: Point = [42.3493, -71.078];
const HARVARD_BRIDGE: Point = [42.3545, -71.0915];
const MIT: Point = [42.3592, -71.0935];
const NORTHEASTERN: Point = [42.3398, -71.0892];
const FENWAY: Point = [42.3467, -71.0972];
const PRUDENTIAL: Point = [42.3472, -71.0822];

const DAY = 86400000;

function metres(a: Point, b: Point) {
  const lat = ((a[0] + b[0]) / 2) * (Math.PI / 180);
  const north = (b[0] - a[0]) * 111320;
  const east = (b[1] - a[1]) * 111320 * Math.cos(lat);
  return Math.hypot(north, east);
}

/** The corners joined up with a point every 40 metres or so, like a recorded track. */
function trackThrough(corners: Point[]): Point[] {
  const track: Point[] = [corners[0]];
  for (let i = 1; i < corners.length; i++) {
    const from = corners[i - 1];
    const to = corners[i];
    const steps = Math.max(1, Math.round(metres(from, to) / 40));
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      track.push([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]);
    }
  }
  return track;
}

type Plan = {
  daysAgo: number;
  /** Hour of the day it started, e.g. 8.6 for 8:36 */
  hour: number;
  destination: string | null;
  corners: Point[];
  /** Average speed, km/h */
  pace: number;
  topSpeed: number;
  /** Where along the ride each close pass happened, 0 to 1 */
  passes: number[];
};

const PLANS: Plan[] = [
  { daysAgo: 0, hour: 8.6, destination: 'Boston Public Library', corners: [SYMPHONY, MASS_AND_BOYLSTON, LIBRARY], pace: 17, topSpeed: 27, passes: [0.3] },
  { daysAgo: 1, hour: 17.7, destination: 'Symphony Hall', corners: [MIT, HARVARD_BRIDGE, MASS_AND_BOYLSTON, SYMPHONY], pace: 18, topSpeed: 31, passes: [0.25, 0.7] },
  { daysAgo: 1, hour: 8.5, destination: 'MIT', corners: [SYMPHONY, MASS_AND_BOYLSTON, HARVARD_BRIDGE, MIT], pace: 19, topSpeed: 30, passes: [] },
  { daysAgo: 2, hour: 12.4, destination: null, corners: [SYMPHONY, NORTHEASTERN, FENWAY, MASS_AND_BOYLSTON, SYMPHONY], pace: 16, topSpeed: 26, passes: [0.55] },
  { daysAgo: 3, hour: 18.1, destination: 'Symphony Hall', corners: [LIBRARY, PRUDENTIAL, SYMPHONY], pace: 15, topSpeed: 24, passes: [] },
  { daysAgo: 3, hour: 8.7, destination: 'Boston Public Library', corners: [SYMPHONY, PRUDENTIAL, LIBRARY], pace: 16, topSpeed: 25, passes: [] },
  { daysAgo: 5, hour: 10.2, destination: 'Fenway Park', corners: [SYMPHONY, MASS_AND_BOYLSTON, FENWAY], pace: 17, topSpeed: 28, passes: [0.4, 0.45, 0.8] },
];

/** The sample rides, dated back from `now`. */
export function sampleWeek(now: number): Ride[] {
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  return PLANS.map((plan, index) => {
    const track = trackThrough(plan.corners);
    let distance = 0;
    for (let i = 1; i < track.length; i++) distance += metres(track[i - 1], track[i]);
    const duration = (distance / 1000 / plan.pace) * 3600 * 1000;
    let startedAt = midnight - plan.daysAgo * DAY + plan.hour * 3600 * 1000;
    // Today's ride must already be over.
    if (startedAt + duration > now - 60000) startedAt = now - duration - 20 * 60000;
    const id = `ride-sample-${index}`;
    const moments: RideMoment[] = plan.passes.map((along, pass) => ({
      id: `${id}-pass-${pass}`,
      ts: startedAt + duration * along,
      kind: 'close-pass',
      camera: 'rear',
      file: null,
      at: track[Math.round(along * (track.length - 1))],
    }));
    return {
      id,
      startedAt,
      endedAt: startedAt + duration,
      lastSeen: startedAt + duration,
      distance,
      maxSpeedKmh: plan.topSpeed,
      closePasses: plan.passes.length,
      destination: plan.destination,
      moments,
      track,
    };
  }).sort((a, b) => b.startedAt - a.startedAt);
}
