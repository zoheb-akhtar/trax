import AsyncStorage from '@react-native-async-storage/async-storage';
import { readStored } from '@/lib/storage';
import * as Location from 'expo-location';

import type { CameraId, DeviceMode, SecurityEvent } from '@/device/types';
import { deletePictureFolder, savePictureTo } from '@/history/files';
import { placeName } from '@/nav/api';
import { distance } from '@/nav/geo';
import type { LatLon } from '@/nav/types';

export type SecurityKind = 'armed' | 'disarmed' | 'tamper' | 'motion' | 'siren' | 'crash';

export type SecurityEntry = {
  id: string;
  /** Unix time in milliseconds */
  ts: number;
  kind: SecurityKind;
  /** Pictures taken when it happened; paths relative to the documents folder */
  pictures: { camera: CameraId; file: string }[];
  /** Street or place name, when known */
  place: string | null;
  /** What the AI agent saw in the picture, in one sentence. Only for alarms. */
  description?: string;
};

/** Where the bike was when Trax was armed. */
export type Parked = LatLon & { ts: number; place: string | null };

/** Where the device's GPS last reported the bike, and when the phone heard it. */
export type LastSeen = LatLon & { ts: number; place: string | null };

export type SecuritySnapshot = {
  loaded: boolean;
  entries: SecurityEntry[];
  parked: Parked | null;
  lastSeen: LastSeen | null;
};

export type SecurityInput = {
  /** False while the device's state is unknown (offline or still connecting). */
  tracking: boolean;
  mode: DeviceMode;
  events: SecurityEvent[];
  cameras: CameraId[];
  snapshotUrlFor(camera: CameraId): string | null;
  /** The device's GPS position, if it reports one */
  position: LatLon | null;
};

/** The bike's position is re-saved when it has moved this far, or this much time has passed. */
const SEEN_MOVE_M = 8;
const SEEN_EVERY_MS = 15000;
/** The street name is looked up again once the bike is this far from where it was last named. */
const RENAME_M = 40;

const STORAGE_KEY = 'trax.security';
const MAX_ENTRIES = 100;
/** Ids of device events already handled, kept across reloads so cleared ones stay cleared. */
const SEEN_KEPT = 300;

/** The record of what has happened to the bike, kept on the phone. One instance for the app. */
export class SecurityLog {
  private snapshot: SecuritySnapshot = { loaded: false, entries: [], parked: null, lastSeen: null };
  private namedAt: LatLon | null = null;
  private naming = false;
  private listeners = new Set<() => void>();
  private seen = new Set<string>();
  private lastMode: DeviceMode | null = null;
  private loading = false;
  /**
   * False until the first update after (re)connecting. Events already in the device's list at
   * that point happened while the phone wasn't listening: they are logged without a picture.
   * Anything that turns up after that has just happened, whatever the device's clock says.
   */
  private primed = false;

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
    let stored: Partial<SecuritySnapshot> = {};
    try {
      const raw = await readStored(STORAGE_KEY);
      if (raw) stored = JSON.parse(raw);
    } catch {
      // An unreadable log is treated as empty.
    }
    const entries = stored.entries ?? [];
    for (const entry of entries) this.seen.add(entry.id);
    for (const id of (stored as { seen?: string[] }).seen ?? []) this.seen.add(id);
    this.set(
      { loaded: true, entries, parked: stored.parked ?? null, lastSeen: stored.lastSeen ?? null },
      false,
    );
  }

  /** Call with the device's latest state, as often as it changes. */
  update(input: SecurityInput) {
    if (!this.snapshot.loaded) return;
    if (!input.tracking) {
      this.primed = false;
      return;
    }
    if (input.position) this.see(input.position);
    const fresh = this.primed;
    this.primed = true;

    // A change of mode the phone saw happen. Connecting to a device that is already armed is
    // not the owner arming it, so the first update only takes note of the mode.
    if (fresh && this.lastMode && this.lastMode !== input.mode) {
      if (input.mode === 'security') {
        const entry = this.add({ id: `armed-${Date.now()}`, ts: Date.now(), kind: 'armed' });
        this.park(entry.id);
      } else {
        this.add({ id: `disarmed-${Date.now()}`, ts: Date.now(), kind: 'disarmed' });
        this.set({ parked: null });
      }
    }
    this.lastMode = input.mode;

    for (const event of input.events) {
      if (this.seen.has(event.id)) continue;
      // The device's clock may be off (it may have no internet time), so a new event is timed by
      // the phone. One learned about late keeps the device's time, but never one in the future.
      const ts = fresh ? Date.now() : Math.min(event.ts, Date.now());
      const entry = this.add({ id: event.id, ts, kind: event.kind });
      if (fresh) this.photograph(entry.id, input);
    }
  }

  /**
   * Remembers where the device's GPS says the bike is. Once the bike is out of range this is
   * the last place it was known to be, which is what "find my bike" shows.
   */
  private see(at: LatLon) {
    const previous = this.snapshot.lastSeen;
    const now = Date.now();
    if (previous && distance(previous, at) < SEEN_MOVE_M && now - previous.ts < SEEN_EVERY_MS) {
      return;
    }
    this.set({ lastSeen: { ...at, ts: now, place: previous?.place ?? null } });

    if (this.naming || (this.namedAt && previous?.place && distance(this.namedAt, at) < RENAME_M)) {
      return;
    }
    this.naming = true;
    placeName(at)
      .then((place) => {
        this.namedAt = at;
        const current = this.snapshot.lastSeen;
        if (place && current) this.set({ lastSeen: { ...current, place } });
      })
      .catch(() => {})
      .finally(() => {
        this.naming = false;
      });
  }

  /** The alarm was set off from the phone. */
  noteSiren() {
    this.add({ id: `siren-${Date.now()}`, ts: Date.now(), kind: 'siren' });
  }

  /** Records what the AI agent saw in an entry's picture. */
  describe(id: string, description: string) {
    this.set({
      entries: this.snapshot.entries.map((entry) =>
        entry.id === id ? { ...entry, description } : entry,
      ),
    });
  }

  /**
   * Forgets every entry and deletes their pictures. Where the bike is parked and was last seen
   * are kept, and so is the list of events already handled, so old ones don't come back.
   */
  clear() {
    deletePictureFolder('security');
    this.set({ entries: [] });
  }

  delete(id: string) {
    deletePictureFolder(`security/${id}`);
    this.set({ entries: this.snapshot.entries.filter((entry) => entry.id !== id) });
  }

  private add(fields: Pick<SecurityEntry, 'id' | 'ts' | 'kind'>): SecurityEntry {
    this.seen.add(fields.id);
    const entry: SecurityEntry = {
      ...fields,
      pictures: [],
      place: this.snapshot.parked?.place ?? null,
    };
    const entries = [entry, ...this.snapshot.entries].sort((a, b) => b.ts - a.ts);
    for (const dropped of entries.slice(MAX_ENTRIES)) deletePictureFolder(`security/${dropped.id}`);
    this.set({ entries: entries.slice(0, MAX_ENTRIES) });
    return entry;
  }

  private patch(id: string, change: (entry: SecurityEntry) => SecurityEntry) {
    this.set({ entries: this.snapshot.entries.map((e) => (e.id === id ? change(e) : e)) });
  }

  /** Saves a picture from every camera for an event that has just happened. */
  private photograph(id: string, input: SecurityInput) {
    for (const camera of input.cameras) {
      const url = input.snapshotUrlFor(camera);
      if (!url) continue;
      savePictureTo(url, `security/${id}`, `${camera}.jpg`).then((file) => {
        if (file) this.patch(id, (e) => ({ ...e, pictures: [...e.pictures, { camera, file }] }));
      });
    }
  }

  /** Remembers where the phone is as the bike is armed, and looks up the street name. */
  private async park(entryId: string) {
    try {
      const { granted } = await Location.requestForegroundPermissionsAsync();
      if (!granted) return;
      const fix =
        (await Location.getLastKnownPositionAsync()) ??
        (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
      if (!fix) return;
      const at = { lat: fix.coords.latitude, lon: fix.coords.longitude };
      this.set({ parked: { ...at, ts: Date.now(), place: null } });
      const place = await placeName(at);
      if (!place || !this.snapshot.parked) return;
      this.set({ parked: { ...this.snapshot.parked, place } });
      this.patch(entryId, (e) => ({ ...e, place }));
    } catch {
      // Without a location the log still works; it just has no place names.
    }
  }

  private set(patch: Partial<SecuritySnapshot>, save = true) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((l) => l());
    if (save) {
      const { entries, parked, lastSeen } = this.snapshot;
      const seen = [...this.seen].slice(-SEEN_KEPT);
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ entries, parked, lastSeen, seen })).catch(
        () => {},
      );
    }
  }
}
