/**
 * Shape of the data the Trax device reports. This mirrors the JSON returned by
 * `GET /state` on the device — see docs/device-api.md.
 */

import type { LatLon } from '@/nav/types';

export type DeviceMode = 'ride' | 'security';

export type CameraId = 'front' | 'rear';

/**
 * A picture the app can show. Most devices have just front and rear. The perception rig has a
 * third: a second front camera used for security ("security"), with the webcam as "rear".
 */
export type CameraView = CameraId | 'security';

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
  /** Which picture it was seen in, when the device has more than one camera per side */
  view?: CameraView;
  /**
   * Where it is, in metres, when the device works this out itself (the perception brain does,
   * from each camera's mounting). x is to the right, z is behind (negative = ahead), as in the
   * app's 3D view. Without it, the app estimates the position from the box.
   */
  world?: { x: number; z: number; distance: number };
};

/** A warning the device worked out itself, e.g. a car about to pass too close. */
export type DeviceAlert = {
  id: string;
  /** e.g. close_pass, collision, rear_collision, right_hook, vehicle_behind, crossing */
  kind: string;
  level: 'danger' | 'caution' | 'info';
  /** Ready to show or say, e.g. "Car passing close on your left" */
  text: string;
  side: 'ahead' | 'behind' | 'left' | 'right' | null;
  /** The detection it is about, if any */
  trackId: number | null;
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
  /** Pictures to choose from on screen, when they differ from `cameras` (the perception rig) */
  views?: CameraView[];
  detections: Detection[];
  /** Newest first */
  events: SecurityEvent[];
  /** Road bumps felt while riding, newest first (pothole events from the device) */
  bumps: RoadBump[];
  /**
   * Warnings the device works out itself, most severe first. Null when the device doesn't send
   * any (the test server, the simulator); the app then judges closeness from the detections.
   */
  alerts: DeviceAlert[] | null;
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
  streamUrlFor(camera: CameraView): string | null;
  /** URL of one still picture from a camera, or null when there is no real video */
  snapshotUrlFor(camera: CameraView): string | null;
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
  alerts: null,
};
