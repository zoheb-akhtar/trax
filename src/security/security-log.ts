import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';

import type { CameraId, DeviceMode, SecurityEvent } from '@/device/types';
import { deletePictureFolder, savePictureTo } from '@/history/files';
import { placeName } from '@/nav/api';
import type { LatLon } from '@/nav/types';

export type SecurityKind = 'armed' | 'disarmed' | 'tamper' | 'motion' | 'siren';

export type SecurityEntry = {
  id: string;
  /** Unix time in milliseconds */
  ts: number;
  kind: SecurityKind;
  /** Pictures taken when it happened; paths relative to the documents folder */
  pictures: { camera: CameraId; file: string }[];
  /** Street or place name, when known */
  place: string | null;
};

/** Where the bike was when Velo was armed. */
export type Parked = LatLon & { ts: number; place: string | null };

export type SecuritySnapshot = { loaded: boolean; entries: SecurityEntry[]; parked: Parked | null };

export type SecurityInput = {
  /** False while the device's state is unknown (offline or still connecting). */
  tracking: boolean;
  mode: DeviceMode;
  events: SecurityEvent[];
  cameras: CameraId[];
  snapshotUrlFor(camera: CameraId): string | null;
};

const STORAGE_KEY = 'velo.security';
const MAX_ENTRIES = 100;
/**
 * A picture is only worth taking if the event has just happened. Events learned
 * about later (after being out of range) are logged without one.
 */
const FRESH_MS = 8000;

/** The record of what has happened to the bike, kept on the phone. One instance for the app. */
export class SecurityLog {
  private snapshot: SecuritySnapshot = { loaded: false, entries: [], parked: null };
  private listeners = new Set<() => void>();
  private seen = new Set<string>();
  private lastMode: DeviceMode | null = null;
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
    let stored: Partial<SecuritySnapshot> = {};
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) stored = JSON.parse(raw);
    } catch {
      // An unreadable log is treated as empty.
    }
    const entries = stored.entries ?? [];
    for (const entry of entries) this.seen.add(entry.id);
    this.set({ loaded: true, entries, parked: stored.parked ?? null }, false);
  }

  /** Call with the device's latest state, as often as it changes. */
  update(input: SecurityInput) {
    if (!this.snapshot.loaded || !input.tracking) return;

    if (this.lastMode && this.lastMode !== input.mode) {
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
      const entry = this.add({ id: event.id, ts: event.ts, kind: event.kind });
      if (Date.now() - event.ts < FRESH_MS) this.photograph(entry.id, input);
    }
  }

  /** The alarm was set off from the phone. */
  noteSiren() {
    this.add({ id: `siren-${Date.now()}`, ts: Date.now(), kind: 'siren' });
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
      const { entries, parked } = this.snapshot;
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ entries, parked })).catch(() => {});
    }
  }
}
