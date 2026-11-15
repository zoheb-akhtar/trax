import AsyncStorage from '@react-native-async-storage/async-storage';

import type { Detection, DeviceMode } from '@/device/types';
import type { Parked } from '@/security/security-log';

/**
 * One time the bike was left somewhere: where, for how long, and how busy the spot was.
 *
 * This is the parking data Velo collects for the street map: which racks people use, how
 * long bikes stay, and how full the racks get. The counts are numbers only; no pictures or
 * identities are kept.
 */
export type ParkingStay = {
  id: string;
  startedAt: number;
  /** Null while the bike is still parked */
  endedAt: number | null;
  /** Last time the phone confirmed the bike was still parked here */
  lastSeen: number;
  lat: number;
  lon: number;
  place: string | null;
  /** The most other bikes the camera saw parked here at once */
  bikesSeen: number;
  /** The most people the camera saw passing at once */
  peopleSeen: number;
};

export type ParkingSnapshot = { loaded: boolean; stays: ParkingStay[] };

export type ParkingInput = {
  /** Where the bike was parked, from the security log, or null when it isn't */
  parked: Parked | null;
  mode: DeviceMode;
  /** Whether the device is being heard from right now */
  tracking: boolean;
  detections: Detection[];
};

const STORAGE_KEY = 'velo.parking';
const MAX_STAYS = 200;
/** Shorter stops than this aren't parking (arming to test it, a quick stop). */
const MIN_STAY_MS = 30000;
/** If the phone stopped hearing from the bike for this long, the stay ended when it last did. */
const GONE_MS = 10 * 60000;
const SAVE_EVERY_MS = 30000;

export class ParkingLog {
  private snapshot: ParkingSnapshot = { loaded: false, stays: [] };
  private listeners = new Set<() => void>();
  private lastSave = 0;
  private loading = false;

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
    let stays: ParkingStay[] = [];
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) stays = JSON.parse(raw);
    } catch {
      // Unreadable data is treated as empty.
    }
    this.set({ loaded: true, stays }, false);
  }

  update(input: ParkingInput) {
    if (!this.snapshot.loaded) return;
    const now = Date.now();
    const stays = this.snapshot.stays;
    const open = stays.find((stay) => stay.endedAt == null) ?? null;
    const parked = input.mode === 'security' ? input.parked : null;

    if (!parked) {
      if (open) this.end(open, now);
      return;
    }

    const id = `stay-${parked.ts}`;
    if (open && open.id !== id) this.end(open, now);
    const stay = stays.find((s) => s.id === id);
    if (!stay) {
      this.set({
        stays: [
          {
            id,
            startedAt: parked.ts,
            endedAt: null,
            lastSeen: now,
            lat: parked.lat,
            lon: parked.lon,
            place: parked.place,
            bikesSeen: 0,
            peopleSeen: 0,
          },
          ...this.snapshot.stays.filter((s) => s.id !== id),
        ].slice(0, MAX_STAYS),
      });
      return;
    }
    if (stay.endedAt != null) return;

    const bikes = input.tracking ? input.detections.filter((d) => d.label === 'bicycle').length : 0;
    const people = input.tracking ? input.detections.filter((d) => d.label === 'person').length : 0;
    const changed =
      bikes > stay.bikesSeen || people > stay.peopleSeen || (!stay.place && parked.place);
    if (changed) {
      this.patch(id, {
        bikesSeen: Math.max(stay.bikesSeen, bikes),
        peopleSeen: Math.max(stay.peopleSeen, people),
        place: stay.place ?? parked.place,
        lastSeen: input.tracking ? now : stay.lastSeen,
      });
    } else if (input.tracking && now - stay.lastSeen > SAVE_EVERY_MS) {
      this.patch(id, { lastSeen: now });
    }
  }

  /** Adds ready-made stays (the sample week), replacing any with the same ids. */
  seed(stays: ParkingStay[]) {
    const ids = new Set(stays.map((s) => s.id));
    this.set({
      stays: [...stays, ...this.snapshot.stays.filter((s) => !ids.has(s.id))]
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, MAX_STAYS),
    });
  }

  clear() {
    this.set({ stays: [] });
  }

  private end(stay: ParkingStay, now: number) {
    // The app may have been closed for a while: the stay ended no later than the bike was last heard from.
    const endedAt = now - stay.lastSeen > GONE_MS ? stay.lastSeen : now;
    if (endedAt - stay.startedAt < MIN_STAY_MS) {
      this.set({ stays: this.snapshot.stays.filter((s) => s.id !== stay.id) });
    } else {
      this.patch(stay.id, { endedAt }, true);
    }
  }

  private patch(id: string, change: Partial<ParkingStay>, saveNow = false) {
    const stays = this.snapshot.stays.map((s) => (s.id === id ? { ...s, ...change } : s));
    const due = saveNow || Date.now() - this.lastSave > SAVE_EVERY_MS;
    this.set({ stays }, due);
  }

  private set(patch: Partial<ParkingSnapshot>, save = true) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((l) => l());
    if (save) {
      this.lastSave = Date.now();
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(this.snapshot.stays)).catch(() => {});
    }
  }
}

/** How long a stay lasted (or has lasted so far). */
export function stayLength(stay: ParkingStay, now: number) {
  return (stay.endedAt ?? now) - stay.startedAt;
}

/** A place stays have been grouped into: the same rack, give or take GPS error. */
export type ParkingSpot = {
  id: string;
  lat: number;
  lon: number;
  place: string | null;
  stays: ParkingStay[];
  averageMs: number;
  /** The most other bikes seen there at once, across all stays */
  mostBikes: number;
};

/** Stays within this distance of each other are counted as the same spot. */
const SAME_SPOT_M = 60;

function metres(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const north = (b.lat - a.lat) * 111320;
  const east = (b.lon - a.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(north, east);
}

/** Groups stays into spots, busiest first. */
export function parkingSpots(stays: ParkingStay[], now: number): ParkingSpot[] {
  const groups: { lat: number; lon: number; stays: ParkingStay[] }[] = [];
  for (const stay of [...stays].sort((a, b) => a.startedAt - b.startedAt)) {
    const group = groups.find((g) => metres(g, stay) < SAME_SPOT_M);
    if (group) group.stays.push(stay);
    else groups.push({ lat: stay.lat, lon: stay.lon, stays: [stay] });
  }
  return groups
    .map((g) => ({
      id: g.stays[0].id,
      lat: g.lat,
      lon: g.lon,
      place: [...g.stays].reverse().find((s) => s.place)?.place ?? null,
      stays: [...g.stays].sort((a, b) => b.startedAt - a.startedAt),
      averageMs: g.stays.reduce((sum, s) => sum + stayLength(s, now), 0) / g.stays.length,
      mostBikes: Math.max(...g.stays.map((s) => s.bikesSeen)),
    }))
    .sort((a, b) => b.stays.length - a.stays.length || b.mostBikes - a.mostBikes);
}
