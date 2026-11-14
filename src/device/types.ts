/**
 * Shape of the data the Velo device reports. This mirrors the JSON returned by
 * `GET /state` on the device — see docs/device-api.md.
 */

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
  kind: 'tamper' | 'motion';
  /** Unix time in milliseconds */
  ts: number;
};

export type DeviceState = {
  mode: DeviceMode;
  /** True while the device's alarm is sounding */
  alarm: boolean;
  /** 0..100, or null if the device doesn't report it */
  battery: number | null;
  speedKmh: number | null;
  /** Cameras fitted to the device */
  cameras: CameraId[];
  detections: Detection[];
  /** Newest first */
  events: SecurityEvent[];
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
  cameras: ['front'],
  detections: [],
  events: [],
};
