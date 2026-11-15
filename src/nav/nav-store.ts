import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';

import { haptic } from '@/lib/haptics';

import { fetchAlongRoute, fetchRoute, fetchScenery } from './api';
import { pointAlong, snapToRoute } from './geo';
import type {
  Area,
  Building,
  Closure,
  LatLon,
  Parking,
  Place,
  Position,
  Progress,
  Road,
  Route,
} from './types';

export type NavSnapshot = {
  /** Where the trip starts. Null means "wherever I am now". */
  origin: Place | null;
  destination: Place | null;
  /** Plan routes that favour bike lanes and paths. */
  bikeLanes: boolean;
  status: 'idle' | 'routing' | 'ready' | 'error';
  error: string | null;
  route: Route | null;
  /** Parking and closures load after the route, from a slower service. */
  extras: 'idle' | 'loading' | 'ready' | 'error';
  parking: Parking[];
  closures: Closure[];
  /** Street shapes around the route, for the 3D ride view */
  roads: Road[];
  /** Building outlines along the route, for the 3D ride view. They load last. */
  buildings: Building[];
  /** Parks and water along the route */
  areas: Area[];
  position: Position | null;
  navigating: boolean;
  /** True while a demo ride is moving the position along the route. */
  simulated: boolean;
  progress: Progress | null;
};

const INITIAL: NavSnapshot = {
  origin: null,
  destination: null,
  bikeLanes: true,
  status: 'idle',
  error: null,
  route: null,
  extras: 'idle',
  parking: [],
  closures: [],
  roads: [],
  buildings: [],
  areas: [],
  position: null,
  navigating: false,
  simulated: false,
  progress: null,
};

const OFF_ROUTE_M = 45;
/** Further than this from the route, the rider isn't on this trip yet: don't re-plan. */
const REROUTE_WITHIN_M = 1500;
const ARRIVE_M = 25;
/** Distance at which the turn arrow starts flashing, like an indicator. */
export const SIGNAL_DISTANCE_M = 80;
/** After arriving, the route is put away by itself this long later. */
const ARRIVED_LINGER_MS = 8000;
const DEMO_SPEED_MPS = 9;
const DEMO_TICK_MS = 200;
const REROUTE_EVERY_MS = 8000;
/** How long the rider must stay off the route before a new one is planned. */
const OFF_ROUTE_WAIT_MS = 3500;

/** Trip planning and turn-by-turn state. One instance for the whole app. */
export class NavStore {
  private snapshot = INITIAL;
  private listeners = new Set<() => void>();
  private planning: AbortController | null = null;
  private watcher: Location.LocationSubscription | null = null;
  private demoTimer: ReturnType<typeof setInterval> | null = null;
  private demoAlong = 0;
  private signalledAt: number | null = null;
  private rerouting = false;
  private offRouteTimer: ReturnType<typeof setTimeout> | null = null;
  /** The route whose surroundings (streets, parking, buildings) were last requested. */
  private loadedFor: Route | null = null;
  /** The last position that came from the phone's GPS rather than a Preview ride. */
  private lastRealFix: Position | null = null;
  private arrivalTimer: ReturnType<typeof setTimeout> | null = null;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  private set(patch: Partial<NavSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((l) => l());
  }

  dispose() {
    this.planning?.abort();
    this.stopTracking();
  }

  // ---- Trip planning -----------------------------------------------------------

  setOrigin(origin: Place | null) {
    this.set({ origin });
    this.plan();
  }

  setDestination(destination: Place | null) {
    this.set({ destination });
    this.plan();
  }

  setBikeLanes(bikeLanes: boolean) {
    this.set({ bikeLanes });
    this.plan();
  }

  clear() {
    this.planning?.abort();
    this.stopTracking();
    this.set({ ...INITIAL, position: this.realPosition(), bikeLanes: this.snapshot.bikeLanes });
  }

  /** Where the phone really is: a Preview ride's made-up position must not outlive the preview. */
  private realPosition() {
    return this.snapshot.simulated ? this.lastRealFix : this.snapshot.position;
  }

  /** Finds where the phone is. Returns null if location is off or refused. */
  async locate(): Promise<Position | null> {
    try {
      const { granted } = await Location.requestForegroundPermissionsAsync();
      if (!granted) return null;
      const fix =
        (await Location.getLastKnownPositionAsync()) ??
        (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
      const position = toPosition(fix);
      this.lastRealFix = position;
      if (!this.snapshot.simulated) this.set({ position });
      return position;
    } catch {
      return null;
    }
  }

  /** Plans (or re-plans) the route for the current start, end and bike-lane setting. */
  async plan(from?: LatLon) {
    const { destination, origin, bikeLanes } = this.snapshot;
    this.planning?.abort();
    if (!destination) {
      this.set({
        status: 'idle',
        route: null,
        error: null,
        parking: [],
        closures: [],
        roads: [],
        buildings: [],
        areas: [],
        extras: 'idle',
      });
      return;
    }
    const controller = new AbortController();
    this.planning = controller;
    this.set({ status: 'routing', error: null });

    try {
      const start = from ?? origin ?? (await this.locate());
      if (controller.signal.aborted) return;
      if (!start) {
        this.set({
          status: 'error',
          error: 'Location is off. Type a starting point, or allow location for Velo.',
        });
        return;
      }
      const route = await fetchRoute(start, destination, bikeLanes, controller.signal);
      if (controller.signal.aborted) return;
      // Keep the streets already loaded: a re-plan (such as switching bike lanes) covers
      // much the same area, and fetching them again takes around half a minute.
      this.set({ status: 'ready', route, parking: [], closures: [], extras: 'loading' });
      this.updateProgress();

      this.loadExtras(route, controller);
    } catch (error) {
      if (controller.signal.aborted) return;
      this.set({
        status: 'error',
        error: error instanceof Error ? error.message : 'Could not plan a route.',
      });
    }
  }

  /** Loads parking and closures again after a failure. */
  retryExtras() {
    const { route } = this.snapshot;
    if (!route) return;
    const controller =
      this.planning && !this.planning.signal.aborted ? this.planning : new AbortController();
    this.planning = controller;
    this.set({ extras: 'loading' });
    this.loadExtras(route, controller);
  }

  /** Map data for a new route mid-ride, without disturbing the trip being followed. */
  private loadMap(route: Route) {
    const controller =
      this.planning && !this.planning.signal.aborted ? this.planning : new AbortController();
    this.planning = controller;
    this.loadExtras(route, controller);
  }

  /**
   * Streets, parking and closures first; then buildings, which are only decoration.
   *
   * The free map service is often slow or busy, so this shows the copy saved on the phone
   * from the last time this trip was planned, and tries the service a few times by itself.
   */
  private async loadExtras(route: Route, controller: AbortController) {
    this.loadedFor = route;
    const key = mapKey(route);

    const saved = await readSavedMap(key);
    if (controller.signal.aborted) return;
    if (saved) this.set({ ...saved, extras: 'ready' });

    for (let attempt = 0; attempt < MAP_ATTEMPTS; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, MAP_RETRY_MS));
      if (controller.signal.aborted) return;
      try {
        const found = await fetchAlongRoute(route, controller.signal);
        // A newer route (a reroute) may have replaced this one while it loaded.
        if (controller.signal.aborted || this.loadedFor !== route) return;
        this.set({ ...found, extras: 'ready' });
        let scenery: Awaited<ReturnType<typeof fetchScenery>> | null = null;
        try {
          scenery = await fetchScenery(route, controller.signal);
          if (!controller.signal.aborted && this.loadedFor === route) this.set(scenery);
        } catch {
          // The ride view works without buildings.
        }
        saveMap(key, { ...found, ...(scenery ?? {}) });
        return;
      } catch {
        if (controller.signal.aborted) return;
        // Try again shortly; meanwhile the saved copy (if any) stays on screen.
        if (!saved) this.set({ extras: attempt < MAP_ATTEMPTS - 1 ? 'loading' : 'error' });
      }
    }
  }

  // ---- Riding ------------------------------------------------------------------

  /** Starts turn-by-turn. With `demo`, the position is played along the route instead of read from GPS. */
  async start(demo: boolean) {
    if (!this.snapshot.route) return;
    this.stopTracking();
    this.signalledAt = null;
    this.set({ navigating: true, simulated: demo, error: null });

    if (demo) {
      this.demoAlong = 0;
      this.demoTimer = setInterval(() => this.demoStep(), DEMO_TICK_MS);
      this.demoStep();
      return;
    }

    const { granted } = await Location.requestForegroundPermissionsAsync().catch(() => ({
      granted: false,
    }));
    if (!this.snapshot.navigating) return;
    if (!granted) {
      this.set({
        navigating: false,
        error: 'Location is off, so Velo can’t follow you. Turn it on, or use Preview.',
      });
      return;
    }
    const watcher = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 2 },
      (fix) => {
        const position = toPosition(fix);
        this.lastRealFix = position;
        this.onPosition(position);
      },
    );
    // Stopped while the watcher was starting: don't leave it running.
    if (!this.snapshot.navigating || this.snapshot.simulated) watcher.remove();
    else this.watcher = watcher;
  }

  stop() {
    const position = this.realPosition();
    this.stopTracking();
    this.set({ navigating: false, simulated: false, progress: null, position });
    this.updateProgress();
  }

  private stopTracking() {
    this.cancelOffRouteCheck();
    if (this.arrivalTimer) clearTimeout(this.arrivalTimer);
    this.arrivalTimer = null;
    this.watcher?.remove();
    this.watcher = null;
    if (this.demoTimer) clearInterval(this.demoTimer);
    this.demoTimer = null;
  }

  private demoStep() {
    const { route } = this.snapshot;
    if (!route) return;
    this.demoAlong = Math.min(
      this.demoAlong + DEMO_SPEED_MPS * (DEMO_TICK_MS / 1000),
      route.distance,
    );
    this.onPosition(pointAlong(route.points, route.cumulative, this.demoAlong));
    if (this.demoAlong >= route.distance && this.demoTimer) {
      clearInterval(this.demoTimer);
      this.demoTimer = null;
    }
  }

  private onPosition(position: Position) {
    this.set({ position });
    this.updateProgress();

    const { progress, navigating, simulated } = this.snapshot;
    if (!navigating || !progress) return;

    // Arrived: leave the message up briefly, then finish the trip so the screen isn't left
    // showing a route that is over.
    if (progress.arrived) {
      if (!this.arrivalTimer) {
        haptic.commit();
        this.arrivalTimer = setTimeout(() => this.clear(), ARRIVED_LINGER_MS);
      }
      return;
    }

    // One buzz as a left or right turn comes up.
    const next = progress.next;
    if (
      next &&
      progress.distanceToNext < SIGNAL_DISTANCE_M &&
      this.signalledAt !== next.at &&
      (next.direction.includes('left') || next.direction.includes('right'))
    ) {
      this.signalledAt = next.at;
      haptic.tap();
    }

    // Strayed from the route: if still off it a few seconds from now, plan again from here.
    // This runs on a timer, not on GPS fixes, so it also works when the rider has stopped.
    if (simulated) return;
    if (!progress.offRoute) {
      this.cancelOffRouteCheck();
    } else if (!this.offRouteTimer) {
      this.offRouteTimer = setTimeout(() => this.checkOffRoute(), OFF_ROUTE_WAIT_MS);
    }
  }

  private cancelOffRouteCheck() {
    if (this.offRouteTimer) clearTimeout(this.offRouteTimer);
    this.offRouteTimer = null;
  }

  private checkOffRoute() {
    this.offRouteTimer = null;
    const { progress, position, navigating, simulated } = this.snapshot;
    if (!navigating || simulated || !progress?.offRoute || !position) return;
    if (progress.offBy < REROUTE_WITHIN_M) this.reroute(position);
    // Look again later, in case that failed or the rider keeps straying.
    this.offRouteTimer = setTimeout(() => this.checkOffRoute(), REROUTE_EVERY_MS);
  }

  /** Plans a fresh route from where the rider is now. Keeps the current one if that fails. */
  private async reroute(from: LatLon) {
    const { destination, bikeLanes } = this.snapshot;
    if (!destination || this.rerouting) return;
    this.rerouting = true;
    this.updateProgress();
    try {
      const route = await fetchRoute(from, destination, bikeLanes);
      if (!this.snapshot.navigating || this.snapshot.destination !== destination) return;
      this.signalledAt = null;
      this.set({ route });
      // The new route may run through streets that were never loaded for the old one.
      if (!covers(this.loadedFor, route)) this.loadMap(route);
    } catch {
      // Keep following the old route; the next off-route check tries again.
    } finally {
      this.rerouting = false;
      this.updateProgress();
    }
  }

  private updateProgress() {
    const { route, position, navigating } = this.snapshot;
    if (!route || !position || !navigating) {
      if (this.snapshot.progress) this.set({ progress: null });
      return;
    }
    const snap = snapToRoute(route.points, route.cumulative, position);
    const remaining = Math.max(route.distance - snap.along, 0);
    // Turns still ahead. The first maneuver is just "set off", which is not a turn.
    const ahead = route.maneuvers.filter((m, i) => i > 0 && m.at > snap.along + 5);
    const next = ahead[0] ?? route.maneuvers[route.maneuvers.length - 1] ?? null;

    this.set({
      progress: {
        along: snap.along,
        heading: position.heading ?? pointAlong(route.points, route.cumulative, snap.along).heading,
        remaining,
        remainingTime: route.distance > 0 ? (remaining / route.distance) * route.duration : 0,
        next,
        distanceToNext: next ? Math.max(next.at - snap.along, 0) : remaining,
        then: ahead[1] ?? null,
        offRoute: snap.off > OFF_ROUTE_M,
        offBy: snap.off,
        rerouting: this.rerouting,
        // Near the end of the route and actually on it, not merely level with it a street away.
        arrived: remaining < ARRIVE_M && snap.off < OFF_ROUTE_M,
      },
    });
  }
}

function toPosition(fix: Location.LocationObject): Position {
  const heading = fix.coords.heading;
  return {
    lat: fix.coords.latitude,
    lon: fix.coords.longitude,
    heading: heading != null && heading >= 0 ? heading : null,
  };
}

/** Whether the map data loaded around one route (its box plus a margin) also covers another. */
function covers(loaded: Route | null, route: Route) {
  if (!loaded) return false;
  const margin = 0.0025; // inside the 400 m the data was fetched with
  const lats = loaded.points.map((p) => p.lat);
  const lons = loaded.points.map((p) => p.lon);
  const south = Math.min(...lats) - margin;
  const north = Math.max(...lats) + margin;
  const west = Math.min(...lons) - margin;
  const east = Math.max(...lons) + margin;
  return route.points.every(
    (p) => p.lat >= south && p.lat <= north && p.lon >= west && p.lon <= east,
  );
}

// ---- Map data saved on the phone -------------------------------------------------------

/** How many times to ask the map service before giving up, and how long between tries. */
const MAP_ATTEMPTS = 4;
const MAP_RETRY_MS = 6000;
const MAP_INDEX_KEY = 'velo.maps';
/** Trips whose map data is kept; the oldest is dropped beyond this. */
const MAPS_KEPT = 6;

type SavedMap = Partial<Pick<NavSnapshot, 'roads' | 'parking' | 'closures' | 'buildings' | 'areas'>>;

/** Identifies a trip by where it starts and ends, to about 100 metres. */
function mapKey(route: Route) {
  const round = (p: { lat: number; lon: number }) => `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`;
  return `velo.map.${round(route.points[0])}-${round(route.points[route.points.length - 1])}`;
}

async function readSavedMap(key: string): Promise<SavedMap | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as SavedMap) : null;
  } catch {
    return null;
  }
}

async function saveMap(key: string, map: SavedMap) {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(map));
    const raw = await AsyncStorage.getItem(MAP_INDEX_KEY);
    const keys: string[] = [key, ...(raw ? (JSON.parse(raw) as string[]) : []).filter((k) => k !== key)];
    await Promise.all(keys.slice(MAPS_KEPT).map((old) => AsyncStorage.removeItem(old)));
    await AsyncStorage.setItem(MAP_INDEX_KEY, JSON.stringify(keys.slice(0, MAPS_KEPT)));
  } catch {
    // Saving is a convenience; the map on screen is unaffected.
  }
}
