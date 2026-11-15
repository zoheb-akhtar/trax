import AsyncStorage from '@react-native-async-storage/async-storage';
import { readStored } from '@/lib/storage';

import { isCloseVehicle, toWorld } from '@/device/geometry';
import type { CameraId, Detection, DeviceMode, RoadBump } from '@/device/types';

import { deletePictureFolder, deleteRidePictures, savePicture } from './files';

export type RideMoment = {
  id: string;
  /** Unix time in milliseconds */
  ts: number;
  /** "frame" is a routine picture; "close-pass" is taken when a vehicle gets close. */
  kind: 'frame' | 'close-pass';
  camera: CameraId;
  /** Picture path relative to the documents folder, or null if none was saved */
  file: string | null;
  /** Where it happened, as [lat, lon], when the phone knew its position */
  at?: [number, number];
};

/** A pothole or bad patch of road felt during a ride. */
export type Pothole = {
  id: string;
  ts: number;
  /** Peak vertical jolt beyond normal, in g */
  severity: number;
  /** Where it happened, as [lat, lon], when known */
  at?: [number, number];
};

export type Ride = {
  id: string;
  startedAt: number;
  /** Null while the ride is still being recorded */
  endedAt: number | null;
  lastSeen: number;
  /** Metres, from the device's speed over time */
  distance: number;
  maxSpeedKmh: number;
  closePasses: number;
  destination: string | null;
  moments: RideMoment[];
  /** The path ridden, as [lat, lon] points. Missing on rides saved by older versions. */
  track?: [number, number][];
  /** Potholes felt by the IMU. Missing on rides saved by older versions. */
  potholes?: Pothole[];
};

export type RideHistorySnapshot = { loaded: boolean; rides: Ride[] };

export type RideInput = {
  mode: DeviceMode;
  speedKmh: number | null;
  detections: Detection[];
  cameras: CameraId[];
  snapshotUrlFor(camera: CameraId): string | null;
  destination: string | null;
  /** The phone's position, when known */
  position: { lat: number; lon: number } | null;
  /** Road bumps the device has reported, newest first */
  bumps: RoadBump[];
};

const STORAGE_KEY = 'trax.rides';
/** A ride starts once the bike is moving faster than this. */
const START_KMH = 5;
/** Shorter recordings than this are thrown away. */
const MIN_RIDE_MS = 20000;
/** A routine picture from each camera this often. */
const FRAME_EVERY_MS = 10000;
/** About an hour of routine pictures from two cameras; close passes are always kept. */
const MAX_FRAMES = 720;
/** Older rides, and their pictures, are deleted beyond this many. */
const MAX_RIDES = 20;
/**
 * A car that overtakes is seen behind, vanishes alongside the bike, then reappears ahead.
 * That is one pass, so a new one is only counted after this long with nothing close.
 */
const PASS_GAP_MS = 4000;
/** A ride ends by itself after this long at a standstill. */
const STANDSTILL_MS = 120000;
const STILL_KMH = 2;
/** A new point is added to the path after moving this far. */
const TRACK_STEP_M = 8;
const MAX_TRACK_POINTS = 3000;
const PUBLISH_EVERY_MS = 2000;
/** Jolts smaller than this (in g beyond normal) are ordinary rough road, not potholes. */
const MIN_POTHOLE_G = 0.8;
const SAVE_EVERY_MS = 15000;

/** Records rides as they happen and keeps the list of past ones. One instance for the app. */
export class RideHistory {
  private snapshot: RideHistorySnapshot = { loaded: false, rides: [] };
  private listeners = new Set<() => void>();
  private finished: Ride[] = [];
  private active: Ride | null = null;
  private lastTick = 0;
  private lastFrames = 0;
  private lastPublish = 0;
  private lastSave = 0;
  private lastCloseAt = 0;
  private capturing = false;
  private stillSince: number | null = null;
  private loading = false;
  /** Bumps already looked at, so each is recorded once. */
  private seenBumps = new Set<string>();
  private bumpsPrimed = false;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  async load() {
    if (this.loading) return;
    this.loading = true;
    let rides: Ride[] = [];
    try {
      const raw = await readStored(STORAGE_KEY);
      if (raw) rides = JSON.parse(raw);
    } catch {
      // Unreadable history is treated as empty.
    }
    // A ride left open when the app was closed ended when it was last heard from.
    const closed = rides.map((ride) =>
      ride.endedAt == null ? { ...ride, endedAt: ride.lastSeen } : ride,
    );
    this.finished = closed.filter((ride) => {
      const keep = (ride.endedAt ?? ride.lastSeen) - ride.startedAt >= MIN_RIDE_MS;
      if (!keep) deleteRidePictures(ride.id);
      return keep;
    });
    this.snapshot = { ...this.snapshot, loaded: true };
    this.publish();
  }

  /** Call with the device's latest state, as often as it changes. */
  update(input: RideInput) {
    if (!this.snapshot.loaded) return;
    const now = Date.now();
    const ride = this.active;

    // Bumps reported before the app was watching (an old list on the device) aren't new.
    const fresh = input.bumps.filter((b) => !this.seenBumps.has(b.id));
    for (const b of fresh) this.seenBumps.add(b.id);
    const newBumps = this.bumpsPrimed ? fresh : [];
    this.bumpsPrimed = true;

    if (!ride) {
      if (input.mode === 'ride' && (input.speedKmh ?? 0) > START_KMH) this.begin(now, input);
      return;
    }
    if (input.mode !== 'ride') {
      this.end(now);
      return;
    }

    const dt = Math.min((now - this.lastTick) / 1000, 2);
    this.lastTick = now;
    const speed = input.speedKmh ?? 0;
    ride.distance += (speed / 3.6) * dt;
    ride.maxSpeedKmh = Math.max(ride.maxSpeedKmh, speed);
    ride.lastSeen = now;
    if (input.destination) ride.destination = input.destination;

    // Stopped for a couple of minutes: the ride is over, even if nobody tapped End ride.
    if (speed > STILL_KMH) this.stillSince = null;
    else if (this.stillSince === null) this.stillSince = now;
    else if (now - this.stillSince > STANDSTILL_MS) {
      this.end(this.stillSince);
      return;
    }

    // Potholes, placed where the device's GPS felt them, or else where the phone is.
    for (const bump of newBumps) {
      if (bump.severity < MIN_POTHOLE_G) continue;
      const where = bump.position ?? input.position;
      (ride.potholes ??= []).push({
        id: bump.id,
        ts: now,
        severity: bump.severity,
        at: where ? [where.lat, where.lon] : undefined,
      });
    }

    // The path ridden, one point every few metres.
    const here = input.position;
    if (here) {
      const track = (ride.track ??= []);
      const last = track[track.length - 1];
      const moved = last
        ? Math.hypot((here.lat - last[0]) * 111320, (here.lon - last[1]) * 82000)
        : Infinity;
      if (moved > TRACK_STEP_M && track.length < MAX_TRACK_POINTS) track.push([here.lat, here.lon]);
    }

    // A picture at the moment a vehicle first gets close, from the camera that sees it.
    const close = input.detections
      .filter(isCloseVehicle)
      .sort((a, b) => toWorld(a).distance - toWorld(b).distance)[0];
    if (close) {
      if (now - this.lastCloseAt > PASS_GAP_MS) {
        ride.closePasses += 1;
        this.capture(ride, input, close.camera ?? 'front', 'close-pass', now);
      }
      this.lastCloseAt = now;
    }

    // Routine pictures from every camera.
    const frames = ride.moments.filter((m) => m.kind === 'frame').length;
    if (now - this.lastFrames >= FRAME_EVERY_MS && frames < MAX_FRAMES && !this.capturing) {
      this.lastFrames = now;
      for (const camera of input.cameras) this.capture(ride, input, camera, 'frame', now);
    }

    if (now - this.lastPublish >= PUBLISH_EVERY_MS) this.publish();
    if (now - this.lastSave >= SAVE_EVERY_MS) this.save();
  }

  delete(id: string) {
    if (this.active?.id === id) this.active = null;
    this.finished = this.finished.filter((ride) => ride.id !== id);
    deleteRidePictures(id);
    this.publish();
    this.save();
  }

  /** Adds ready-made rides (the sample week), replacing any with the same ids. */
  seed(rides: Ride[]) {
    const ids = new Set(rides.map((ride) => ride.id));
    this.finished = [...rides, ...this.finished.filter((ride) => !ids.has(ride.id))].sort(
      (a, b) => b.startedAt - a.startedAt,
    );
    this.publish();
    this.save();
  }

  /** Forgets every ride and deletes their pictures. A ride in progress starts again from zero. */
  clear() {
    this.active = null;
    this.finished = [];
    deletePictureFolder('rides');
    this.publish();
    this.save();
  }

  private begin(now: number, input: RideInput) {
    this.active = {
      id: `ride-${now}`,
      startedAt: now,
      endedAt: null,
      lastSeen: now,
      distance: 0,
      maxSpeedKmh: 0,
      closePasses: 0,
      destination: input.destination,
      moments: [],
      track: [],
      potholes: [],
    };
    this.stillSince = null;
    this.lastTick = now;
    this.lastFrames = 0;
    this.lastCloseAt = 0;
    this.lastSave = now;
    this.publish();
  }

  private end(now: number) {
    const ride = this.active;
    if (!ride) return;
    this.active = null;
    if (now - ride.startedAt < MIN_RIDE_MS) {
      deleteRidePictures(ride.id);
    } else {
      this.finished = [{ ...ride, endedAt: now }, ...this.finished];
      for (const old of this.finished.slice(MAX_RIDES)) deleteRidePictures(old.id);
      this.finished = this.finished.slice(0, MAX_RIDES);
    }
    this.publish();
    this.save();
  }

  private capture(
    ride: Ride,
    input: RideInput,
    camera: CameraId,
    kind: RideMoment['kind'],
    ts: number,
  ) {
    const add = (file: string | null) => {
      // The ride may have ended or been deleted while the picture was downloading.
      if (this.active !== ride) return;
      const at: [number, number] | undefined = input.position
        ? [input.position.lat, input.position.lon]
        : undefined;
      ride.moments.push({ id: `${ts}-${camera}-${kind}`, ts, kind, camera, file, at });
      this.publish();
    };
    const url = input.snapshotUrlFor(camera);
    if (!url) {
      // No real camera (simulated device): still note a close pass, without a picture.
      if (kind === 'close-pass') add(null);
      return;
    }
    if (kind === 'frame') this.capturing = true;
    savePicture(url, ride.id, `${ts}-${camera}-${kind}.jpg`)
      .then((file) => {
        if (file || kind === 'close-pass') add(file);
      })
      .finally(() => {
        if (kind === 'frame') this.capturing = false;
      });
  }

  private publish() {
    this.lastPublish = Date.now();
    const active = this.active ? [{ ...this.active, moments: [...this.active.moments] }] : [];
    this.snapshot = { loaded: this.snapshot.loaded, rides: [...active, ...this.finished] };
    this.listeners.forEach((l) => l());
  }

  private save() {
    this.lastSave = Date.now();
    const rides = this.active ? [this.active, ...this.finished] : this.finished;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(rides)).catch(() => {});
  }
}

/** How calm a ride was, 0-100, from close passes per kilometre. */
/**
 * How calm a ride was, 0-100. 100 is no close passes.
 *
 * Close passes are counted per kilometre, with a few kilometres of calm riding assumed on top,
 * so one pass on a short ride doesn't sink the score: one close pass on a normal ride still
 * scores in the 90s. The score then falls off smoothly as passes become frequent.
 *   1 pass in 2 km: 95.   3 in 4 km: 90.   10 in 5 km: 73.   30 in 4 km: about 35.
 */
const SCORE_PRIOR_KM = 3;
const SCORE_FALLOFF = 0.26;
const SCORE_FLOOR = 20;

export function safetyScore(ride: Pick<Ride, 'distance' | 'closePasses'>) {
  if (ride.closePasses <= 0) return 100;
  const perKm = ride.closePasses / (ride.distance / 1000 + SCORE_PRIOR_KM);
  return Math.max(Math.round(100 * Math.exp(-SCORE_FALLOFF * perKm)), SCORE_FLOOR);
}

/**
 * "This week" everywhere in the app: today and the six days before it, by the calendar.
 * Returns the time at which that week starts.
 */
export function weekStart(now: number) {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return midnight.getTime() - 6 * 86400000;
}

/** The safety score of a set of rides taken together: all their close passes over all their distance. */
export function combinedSafetyScore(rides: Ride[]) {
  if (rides.length === 0) return null;
  return safetyScore({
    distance: rides.reduce((sum, ride) => sum + ride.distance, 0),
    closePasses: rides.reduce((sum, ride) => sum + ride.closePasses, 0),
  });
}

/** The colour that goes with a safety score's rating: green calm, blue steady, orange busy, red tense. */
export function safetyColor(score: number) {
  if (score >= 85) return '#16A34A';
  if (score >= 65) return '#2563EB';
  if (score >= 45) return '#D97706';
  return '#DC2626';
}

export function safetyLabel(score: number) {
  if (score >= 85) return 'Calm';
  if (score >= 65) return 'Steady';
  if (score >= 45) return 'Busy';
  return 'Tense';
}
