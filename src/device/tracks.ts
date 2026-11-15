import { isCloseVehicle, toWorld } from './geometry';
import type { Detection } from './types';

/**
 * A track with no fresh detection for this long counts as lost. Over Wi-Fi, with a detector
 * running a few times a second, updates can be most of a second apart.
 */
const STALE_AFTER = 1.0;
/** Speeds measured from jittery boxes are capped at this (m/s), and blended in gently. */
const MAX_SPEED_MPS = 20;
const SPEED_BLEND = 0.35;
/** How long an object that is simply lost (not beside the bike) takes to fade out. */
const FADE_SECONDS = 1.3;

/**
 * The cameras look forwards and backwards, so nothing beside the bike is seen. A vehicle
 * or cyclist that vanishes inside this box (metres) was last seen about to enter that gap,
 * so it is held as "alongside" instead of fading away.
 */
const SIDE_ZONE_AHEAD_M = 6;
const SIDE_ZONE_BEHIND_M = 9;
const SIDE_ZONE_ACROSS_M = 6;
/** A held object is given up on after this long, even if it seems to be keeping pace. */
const MAX_HOLD_SECONDS = 6;
/** Slower than this relative to the bike (m/s), it is treated as keeping pace alongside. */
const PACING_MPS = 0.6;
const MAX_HOLD_SPEED_MPS = 12;
/** A newly seen object this close to a held one of the same kind is taken to be the same one. */
const REJOIN_M = 7;
/** A held object is drawn like any other, so it doesn't seem to vanish. */
const HELD_ALPHA = 1;

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
  /** When it was lost into the gap beside the bike; null while seen or merely fading */
  heldSince: number | null;
  /** The box last received, to tell a repeated report from a real new position */
  box: string;
};

export type SceneObject = {
  id: number;
  label: string;
  close: boolean;
  x: number;
  z: number;
  /** 0..1, for fading in and out */
  alpha: number;
  /** True while it is out of the cameras' sight beside the bike, and its position is a guess */
  held: boolean;
};

/**
 * Turns the device's detections, which arrive a few times a second and jump
 * around, into smoothly moving objects for the 3D view. Objects glide between
 * updates, and one that disappears into the gap beside the bike is carried
 * through it at the speed it was closing.
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
        t.heldSince = null;
      } else {
        if (t.heldSince === null && this.enteredSideGap(t)) t.heldSince = now;
        const holding = t.heldSince !== null && this.stillAlongside(t, now);
        if (holding) {
          // Carry it through the gap at the speed it was closing; keep pace if it was barely moving.
          const speed = Math.abs(t.vz) < PACING_MPS ? 0 : clamp(t.vz, MAX_HOLD_SPEED_MPS);
          t.z += speed * dt;
          t.alpha += (HELD_ALPHA - t.alpha) * (1 - Math.exp(-dt * 6));
        } else {
          t.x += t.vx * dt;
          t.z += t.vz * dt;
          t.alpha -= dt / FADE_SECONDS;
          if (t.alpha <= 0) {
            this.tracks.delete(id);
            continue;
          }
        }
        out.push({
          id,
          label: t.label,
          close: t.close,
          x: t.x,
          z: t.z,
          alpha: t.alpha,
          held: holding,
        });
        continue;
      }
      out.push({ id, label: t.label, close: t.close, x: t.x, z: t.z, alpha: t.alpha, held: false });
    }
    return out;
  }

  /** Whether a lost track was last seen where the cameras' view gives way to the side gap. */
  private enteredSideGap(t: Track) {
    return (
      t.label !== 'person' &&
      Math.abs(t.x) < SIDE_ZONE_ACROSS_M &&
      t.z < SIDE_ZONE_BEHIND_M &&
      t.z > -SIDE_ZONE_AHEAD_M
    );
  }

  private stillAlongside(t: Track, now: number) {
    return (
      now - (t.heldSince ?? now) < MAX_HOLD_SECONDS &&
      t.z < SIDE_ZONE_BEHIND_M + 1 &&
      t.z > -SIDE_ZONE_AHEAD_M
    );
  }

  private ingest(d: Detection, now: number) {
    const p = toWorld(d);
    let existing = this.tracks.get(d.id);

    // Something appearing where a held object should be coming out is that same object,
    // even if the device has given it a new id: carry on from where it was drawn.
    if (!existing) {
      for (const [id, held] of this.tracks) {
        if (
          held.heldSince !== null &&
          held.label === d.label &&
          Math.hypot(held.x - p.x, held.z - p.z) < REJOIN_M
        ) {
          this.tracks.delete(id);
          this.tracks.set(d.id, held);
          existing = held;
          break;
        }
      }
    }

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
        heldSince: null,
        box: d.box.join(','),
      });
      return;
    }
    // A slow detector repeats its last result between frames. That says the object is still
    // there, not that it has stopped, so it must not drag the speed estimate to zero.
    const box = d.box.join(',');
    if (box === existing.box && existing.heldSince === null) {
      existing.lastSeen = now;
      return;
    }
    existing.box = box;
    const elapsed = Math.max(now - existing.lastSeen, 0.03);
    // After a spell out of sight the old speed estimate is stale, so don't blend with it.
    const blend = existing.heldSince !== null || elapsed > 1.5 ? 0 : SPEED_BLEND;
    if (blend > 0) {
      const vx = clamp((p.x - existing.tx) / elapsed, MAX_SPEED_MPS);
      const vz = clamp((p.z - existing.tz) / elapsed, MAX_SPEED_MPS);
      existing.vx += (vx - existing.vx) * blend;
      existing.vz += (vz - existing.vz) * blend;
    }
    existing.tx = p.x;
    existing.tz = p.z;
    existing.lastSeen = now;
    existing.label = d.label;
    existing.close = isCloseVehicle(d);
    existing.heldSince = null;
  }
}

function clamp(value: number, limit: number) {
  return Math.min(Math.max(value, -limit), limit);
}
