/**
 * Shape of the data the Trax device reports. This mirrors the JSON returned by
 * `GET /state` on the device — see docs/device-api.md.
 */

import type { LatLon } from '@/nav/types';

export type DeviceMode = 'ride' | 'security';

export type CameraId = 'front' | 'rear';

export type Detection = {
  id: number;
  /** e.g. "car", "person", "bicycle" */
  label: string;
  /** 0..1 */
  confidence: number;
  /** [x, y, width, height], each 0..1 relative to the camera frame, origin top-left */
  box: [number, number, number, number];
  /** Which camera saw it. Defaults to the front camera. */
  camera?: CameraId;
};

export type SecurityEvent = {
  id: string;
  /** tamper: bike moved while armed. motion: movement nearby. crash: a fall while riding. */
  kind: 'tamper' | 'motion' | 'crash';
  /** Unix time in milliseconds */
  ts: number;
};

/** A sharp jolt felt by the IMU while riding: a pothole, a kerb, a bad patch of road. */
export type RoadBump = {
  id: string;
  /** Unix time in milliseconds */
  ts: number;
  /** How hard the jolt was: peak vertical acceleration beyond normal, in g */
  severity: number;
  /** Where it happened, from the device's GPS, if it has a fix */
  position: LatLon | null;
};

export type DeviceState = {
  mode: DeviceMode;
  /** True while the device's alarm is sounding */
  alarm: boolean;
  /** 0..100, or null if the device doesn't report it */
  battery: number | null;
  speedKmh: number | null;
  /** Where the device's own GPS says the bike is, or null without a GPS or a fix */
  position: LatLon | null;
  /** True when the device has a speaker and accepts /say and /play */
  speaker: boolean;
  /** Cameras fitted to the device */
  cameras: CameraId[];
  detections: Detection[];
  /** Newest first */
  events: SecurityEvent[];
  /** Road bumps felt while riding, newest first (pothole events from the device) */
  bumps: RoadBump[];
};

export type Connection = 'simulated' | 'connecting' | 'connected' | 'offline';

export type DeviceSnapshot = {
  connection: Connection;
  state: DeviceState;
};

export interface DeviceSource {
  start(): void;
  stop(): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): DeviceSnapshot;
  setMode(mode: DeviceMode): void;
  silenceAlarm(): void;
  /** Sets the alarm off on purpose, to find the bike or scare someone away */
  soundAlarm(): void;
  /** A short beep and flash, to find the bike */
  chirp(): void;
  /**
   * Says a line through the bike's speaker. Urgent lines cut off whatever it is saying.
   * Returns false if it could not be sent (no speaker, or no connection).
   */
  say(text: string, urgent: boolean): Promise<boolean>;
  /** Plays a short recording (m4a) through the bike's speaker, e.g. the owner's voice. */
  play(audio: Uint8Array): Promise<boolean>;
  /** MJPEG stream URL for a camera, or null when there is no real video (simulation) */
  streamUrlFor(camera: CameraId): string | null;
  /** URL of one still picture from a camera, or null when there is no real video */
  snapshotUrlFor(camera: CameraId): string | null;
}

export const EMPTY_STATE: DeviceState = {
  mode: 'ride',
  alarm: false,
  battery: null,
  speedKmh: null,
  position: null,
  speaker: false,
  cameras: ['front'],
  detections: [],
  events: [],
  bumps: [],
};
