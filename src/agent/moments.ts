import { safetyLabel, safetyScore, type Ride } from '@/history/ride-history';
import { placeName } from '@/nav/api';
import { formatDistance, formatDuration, formatSpeed } from '@/nav/geo';
import { classifyRoute } from '@/nav/ground';
import type { NavSnapshot } from '@/nav/nav-store';
import type { Route } from '@/nav/types';

/**
 * The facts Velo is given for the two things it says unprompted: a briefing when a route is
 * planned, and a debrief when a ride ends. The wording is left to the model; these functions
 * decide what is true.
 */

const percent = (share: number) => `${Math.round(share * 100)}%`;

/** Which street the route is on at a given distance from its start. */
function streetAt(route: Route, metres: number) {
  let street: string | null = null;
  for (const maneuver of route.maneuvers) {
    if (maneuver.at > metres) break;
    if (maneuver.street) street = maneuver.street;
  }
  return street;
}

export function routeFacts(trip: NavSnapshot): string | null {
  const { route, destination } = trip;
  if (!route || !destination) return null;
  const lines = [
    `Destination: ${destination.name}`,
    `Distance: ${formatDistance(route.distance)}. Time: ${formatDuration(route.duration)}.`,
  ];

  // Street data can still be loading; in that case the briefing simply leaves bike lanes out.
  if (trip.roads.length > 0 && route.distance > 0) {
    const classes = classifyRoute(route, trip.roads);
    let lane = 0;
    let busy = 0;
    let busyMiddle = 0; // distance-weighted centre of the busy stretches
    const streets = new Map<string, number>();
    classes.forEach((kind, i) => {
      const length = route.cumulative[i + 1] - route.cumulative[i];
      if (kind === 'lane') lane += length;
      if (kind !== 'busy') return;
      busy += length;
      const middle = (route.cumulative[i] + route.cumulative[i + 1]) / 2;
      busyMiddle += middle * length;
      const street = streetAt(route, middle);
      if (street) streets.set(street, (streets.get(street) ?? 0) + length);
    });
    lines.push(`On bike lanes or paths: ${percent(lane / route.distance)} of the route.`);
    if (busy / route.distance < 0.05) {
      lines.push('Busy roads without a bike lane: none worth mentioning.');
    } else {
      const where = busyMiddle / busy / route.distance;
      const part = where < 0.33 ? 'near the start' : where > 0.66 ? 'near the end' : 'in the middle';
      const main = [...streets.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      lines.push(
        `Busy roads without a bike lane: ${percent(busy / route.distance)} of the route, mostly ${part}${main ? `, on ${main}` : ''}.`,
      );
    }
  }

  if (trip.extras === 'ready') {
    const names = [...new Set(trip.closures.map((c) => c.name).filter(Boolean))].slice(0, 2);
    lines.push(
      trip.closures.length
        ? `Closures or roadworks near the route: ${trip.closures.length}${names.length ? ` (${names.join(', ')})` : ''}.`
        : 'Closures near the route: none mapped.',
    );
    const parking = trip.parking.find((spot) => spot.good && spot.fromDestination < 350);
    if (parking) {
      lines.push(`Bike parking: good parking ${formatDistance(parking.fromDestination)} from the destination.`);
    }
  }
  return lines.join('\n');
}

/** A ride worth a debrief: long enough to have been a real ride. */
export function worthDebrief(ride: Ride) {
  const seconds = ((ride.endedAt ?? ride.lastSeen) - ride.startedAt) / 1000;
  return ride.distance >= 300 && seconds >= 60;
}

export async function rideFacts(ride: Ride, rides: Ride[]): Promise<string> {
  const seconds = ((ride.endedAt ?? ride.lastSeen) - ride.startedAt) / 1000;
  const score = safetyScore(ride);
  const top = formatSpeed(ride.maxSpeedKmh);
  const lines = [
    `Ride just finished${ride.destination ? ` to ${ride.destination}` : ''}.`,
    `Distance: ${formatDistance(ride.distance)}. Time: ${formatDuration(seconds)}. Top speed: ${top.value} ${top.unit.toLowerCase()}.`,
    `Close passes (a vehicle passing close): ${ride.closePasses}.`,
    `Safety score: ${score} out of 100 (${safetyLabel(score)}). 100 means no close passes.`,
  ];

  const weekAgo = Date.now() - 7 * 86400000;
  const others = rides.filter(
    (other) => other.id !== ride.id && other.endedAt != null && other.startedAt > weekAgo,
  );
  if (others.length > 0) {
    const usual = Math.round(others.reduce((sum, other) => sum + safetyScore(other), 0) / others.length);
    lines.push(`The rider's usual safety score this week: ${usual} out of 100, over ${others.length} other rides.`);
  } else {
    lines.push('No other rides this week to compare with.');
  }

  // Where the close passes were: the street at the middle one.
  const passes = ride.moments.filter((moment) => moment.kind === 'close-pass' && moment.at);
  const middle = passes[Math.floor(passes.length / 2)]?.at;
  if (middle) {
    const place = await Promise.race([
      placeName({ lat: middle[0], lon: middle[1] }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
    ]).catch(() => null);
    if (place) lines.push(`Most of the close passes were near: ${place}.`);
  }
  return lines.join('\n');
}
