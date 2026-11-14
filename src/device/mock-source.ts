import { toBox } from './geometry';
import { SnapshotStore } from './source-base';
import { EMPTY_STATE, type Detection, type DeviceMode, type DeviceSource } from './types';

/** Something on the road, in metres relative to the bike (see geometry.ts). */
type Track = {
  id: number;
  label: string;
  x: number;
  z: number;
  /** Metres per second along z, relative to the bike. Negative = pulling ahead. */
  speed: number;
  from: number;
  to: number;
};

const TICK_MS = 100;

/**
 * Stand-in for the real device so the app can be built and demoed without
 * hardware. It moves a few objects past the bike and reports them the way the
 * real cameras would: as boxes from the front or rear camera, with a blind
 * spot alongside the bike.
 */
export class MockSource extends SnapshotStore implements DeviceSource {
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextId = 1;
  private elapsed = 0;
  private tracks: Track[];

  constructor() {
    super({
      connection: 'simulated',
      state: { ...EMPTY_STATE, battery: 82, speedKmh: 0, cameras: ['front', 'rear'] },
    });
    this.tracks = [
      // Overtakes close on the left: appears behind, passes, pulls away.
      { id: this.nextId++, label: 'car', x: -2, z: 22, speed: -4, from: 30, to: -45 },
      // Faster car one lane further out.
      { id: this.nextId++, label: 'car', x: -5.5, z: -10, speed: -7, from: 35, to: -60 },
      // Another cyclist, a little faster, overtaking in the bike lane.
      { id: this.nextId++, label: 'bicycle', x: -0.9, z: 14, speed: -1.6, from: 22, to: -38 },
      // Someone standing on the right: the bike rides past them.
      { id: this.nextId++, label: 'person', x: 2.4, z: -30, speed: 6, from: -35, to: 12 },
    ];
  }

  streamUrlFor() {
    return null;
  }

  snapshotUrlFor() {
    return null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setMode(mode: DeviceMode) {
    this.patchState({ mode, ...(mode === 'ride' ? { alarm: false } : null) });
  }

  silenceAlarm() {
    this.patchState({ alarm: false });
  }

  simulateTamper() {
    const { state } = this.snapshot;
    const ts = Date.now();
    this.patchState({
      mode: 'security',
      alarm: true,
      events: [{ id: `evt-${ts}`, kind: 'tamper' as const, ts }, ...state.events].slice(0, 20),
    });
  }

  private patchState(patch: Partial<typeof EMPTY_STATE>) {
    this.update({ state: { ...this.snapshot.state, ...patch } });
  }

  private tick() {
    const dt = TICK_MS / 1000;
    this.elapsed += dt;
    const { state } = this.snapshot;

    if (state.mode === 'security') {
      this.patchState({ detections: [], speedKmh: 0 });
      return;
    }

    this.tracks = this.tracks.map((t) => {
      const z = t.z + t.speed * dt;
      const passed = t.speed < 0 ? z < t.to : z > t.to;
      if (!passed) return { ...t, z };
      // Start again further back, as a new object, after a random gap.
      const gap = Math.random() * 25 * Math.sign(t.from || 1);
      return { ...t, id: this.nextId++, z: t.from + gap };
    });

    const detections: Detection[] = [];
    for (const t of this.tracks) {
      const seen = toBox(t.label, t.x, t.z);
      if (seen) {
        detections.push({ id: t.id, label: t.label, confidence: 0.9, ...seen });
      }
    }

    this.patchState({
      detections,
      speedKmh: 22 + Math.sin(this.elapsed / 3) * 4,
      battery: Math.max(5, 82 - this.elapsed / 120),
    });
  }
}
