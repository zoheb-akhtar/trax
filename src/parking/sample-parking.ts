import type { ParkingStay } from './parking-log';

/**
 * A believable week of parking around Back Bay, Boston, to go with the sample week of rides.
 * Loaded from the Device tab.
 */

type Spot = { lat: number; lon: number; place: string };

const LIBRARY: Spot = { lat: 42.3493, lon: -71.078, place: 'Boston Public Library' };
const SYMPHONY: Spot = { lat: 42.343, lon: -71.0858, place: 'Symphony Hall' };
const MIT: Spot = { lat: 42.3592, lon: -71.0935, place: 'MIT' };
const FENWAY: Spot = { lat: 42.3467, lon: -71.0972, place: 'Fenway Park' };
const NORTHEASTERN: Spot = { lat: 42.3398, lon: -71.0892, place: 'Northeastern University' };
const PRUDENTIAL: Spot = { lat: 42.3472, lon: -71.0822, place: 'Prudential Center' };

const DAY = 86400000;
const HOUR = 3600000;

// [days ago, hour of day parked, hours parked, spot, most other bikes seen, most people seen]
const PLAN: [number, number, number, Spot, number, number][] = [
  [0, 8.9, 2.4, LIBRARY, 9, 6],
  [1, 18.0, 2.1, SYMPHONY, 4, 11],
  [1, 8.8, 8.5, MIT, 14, 7],
  [2, 12.8, 1.2, NORTHEASTERN, 11, 9],
  [2, 9.1, 3.0, LIBRARY, 7, 4],
  [3, 18.4, 2.0, SYMPHONY, 3, 8],
  [3, 9.0, 2.8, LIBRARY, 10, 5],
  [4, 13.0, 0.8, PRUDENTIAL, 5, 12],
  [4, 8.7, 8.2, MIT, 15, 6],
  [5, 10.6, 3.5, FENWAY, 6, 14],
  [6, 9.3, 1.9, LIBRARY, 8, 5],
  [6, 14.2, 1.1, NORTHEASTERN, 12, 8],
];

export function sampleParking(now: number): ParkingStay[] {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return PLAN.map(([daysAgo, hour, hours, spot, bikes, people], i) => {
    // A little GPS scatter, as real parking at the same rack would have.
    const jitter = ((i * 37) % 7) - 3;
    let startedAt = midnight.getTime() - daysAgo * DAY + hour * HOUR;
    let endedAt = startedAt + hours * HOUR;
    // Today's stay must already be over.
    if (endedAt > now) {
      endedAt = now - 10 * 60000;
      startedAt = endedAt - hours * HOUR;
    }
    return {
      id: `sample-stay-${i}`,
      startedAt,
      endedAt,
      lastSeen: endedAt,
      lat: spot.lat + jitter * 0.00005,
      lon: spot.lon - jitter * 0.00005,
      place: spot.place,
      bikesSeen: bikes,
      peopleSeen: people,
    };
  });
}
