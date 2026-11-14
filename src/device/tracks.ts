import { isCloseVehicle, toWorld } from './geometry';
import type { Detection } from './types';

/** How long an object keeps gliding on its last heading after the cameras lose it. */
const COAST_SECONDS = 1.3;
const STALE_AFTER = 0.45;

type Track = {
  label: string;
  close: boolean;
  /** Where it is drawn */
  x: number;
  z: number;
  /** Where the cameras last put it, and how fast it was moving */
  tx: number;
  tz: number;
  vx: number;
  vz: number;
  lastSeen: number;
  alpha: number;
};

export type SceneObject = {
  id: number;
  label: string;
  close: boolean;
  x: number;
  z: number;
  /** 0..1, for fading in and out */
  alpha: number;
};

/**
 * Turns the device's detections, which arrive a few times a second and jump
 * around, into smoothly moving objects for the 3D view. Objects glide between
 * updates and coast briefly when the cameras lose them (e.g. alongside the bike).
 */
export class TrackSmoother {
  private tracks = new Map<number, Track>();
  private lastDetections: Detection[] | null = null;

  /** Advance to time `now` (seconds). Pass the latest detections every call. */
  step(detections: Detection[], now: number, dt: number): SceneObject[] {
    if (detections !== this.lastDetections) {
      this.lastDetections = detections;
      for (const d of detections) this.ingest(d, now);
    }

    const out: SceneObject[] = [];
    for (const [id, t] of this.tracks) {
      const age = now - t.lastSeen;
      if (age < STALE_AFTER) {
        // Glide towards the latest position, predicted forward to hide the gap between updates.
        const ease = 1 - Math.exp(-dt * 12);
        t.x += (t.tx + t.vx * age - t.x) * ease;
        t.z += (t.tz + t.vz * age - t.z) * ease;
        t.alpha = Math.min(1, t.alpha + dt * 4);
      } else {
        t.x += t.vx * dt;
        t.z += t.vz * dt;
        t.alpha -= dt / COAST_SECONDS;
        if (t.alpha <= 0) {
          this.tracks.delete(id);
          continue;
        }
      }
      out.push({ id, label: t.label, close: t.close, x: t.x, z: t.z, alpha: t.alpha });
    }
    return out;
  }

  private ingest(d: Detection, now: number) {
    const p = toWorld(d);
    const existing = this.tracks.get(d.id);
    if (!existing) {
      this.tracks.set(d.id, {
        label: d.label,
        close: isCloseVehicle(d),
        x: p.x,
        z: p.z,
        tx: p.x,
        tz: p.z,
        vx: 0,
        vz: 0,
        lastSeen: now,
        alpha: 0,
      });
      return;
    }
    const elapsed = Math.max(now - existing.lastSeen, 0.03);
    existing.vx += ((p.x - existing.tx) / elapsed - existing.vx) * 0.5;
    existing.vz += ((p.z - existing.tz) / elapsed - existing.vz) * 0.5;
    existing.tx = p.x;
    existing.tz = p.z;
    existing.lastSeen = now;
    existing.label = d.label;
    existing.close = isCloseVehicle(d);
  }
}
