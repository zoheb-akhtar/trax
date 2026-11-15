/**
 * Velo device API: TypeScript types + a tiny client for the Trax app.
 *
 * Copy this file into the app (e.g. src/device/velo-api.ts). No dependencies: uses fetch and
 * EventSource (in React Native, poll `getEvents` or use a polyfill like react-native-sse).
 * The device is velo_brain.py on port 8000 (see firmware/APP_INTEGRATION.md for the meaning
 * of each field and suggested UI). Every field the original docs/device-api.md defines is
 * unchanged; everything else is optional, so older device builds still type-check.
 */

// ----------------------------------------------------------------------------- basics
/** Metres in the bike's frame: x = to the rider's right, z = ahead (negative = behind). */
export type XZ = [x: number, z: number];
export type LatLon = { lat: number; lon: number };
export type CameraFacing = 'front' | 'rear';
/** Physical camera: front Pi camera, seat USB webcam (road behind), rear Pi camera (security). */
export type CameraSource = 'front' | 'seat' | 'rear';
export type CameraRole = 'road_front' | 'road_rear' | 'security';
export type Level = 'info' | 'caution' | 'danger';
export type Mode = 'ride' | 'security';

export type ObjectGroup =
  | 'vehicle' | 'bicycle' | 'person' | 'animal' | 'sign' | 'obstacle' | 'micromobility'
  | 'traffic light' | 'face';

/** Labels the device can report (COCO + Velo's open-vocabulary classes). */
export type ObjectLabel =
  | 'person' | 'bicycle' | 'car' | 'motorcycle' | 'bus' | 'train' | 'truck'
  | 'traffic light' | 'stop sign' | 'cat' | 'dog' | 'horse'
  | 'traffic cone' | 'barrier' | 'traffic sign' | 'speed limit sign' | 'crosswalk sign' | 'yield sign'
  | 'one way sign' | 'no entry sign' | 'scooter' | 'skateboard' | 'wheelchair' | 'stroller'
  | 'ambulance' | 'fire truck' | 'police car';

// ----------------------------------------------------------------------------- detections
export interface Detection {
  /** Stable per tracked object, also across cameras (a passing car keeps its id). */
  id: number;
  label: ObjectLabel | string;
  confidence: number;
  /** [x, y, width, height], 0-1 of the frame, origin top-left. */
  box: [number, number, number, number];
  camera: CameraFacing;
  source?: CameraSource;
  group?: ObjectGroup;
  /** Same object seen by another camera (boxes for drawing on that camera's video). */
  alsoSeenBy?: { source: CameraSource; box: [number, number, number, number] }[];
  distanceM?: number;
  position?: XZ;
  /** 0 = straight ahead, 90 = right, 180 = behind, 270 = left. */
  bearingDeg?: number;
  zone?: 'ahead' | 'ahead-left' | 'ahead-right' | 'left' | 'right' | 'behind' | 'behind-left' | 'behind-right';
  /** m/s relative to the bike, [vx, vz]. */
  velocity?: XZ;
  /** + = getting closer, m/s. */
  closingMps?: number;
  /** Its own speed over the ground (needs the bike's GPS speed). */
  speedKmh?: number;
  /** Time to contact, s (from how fast the box grows). */
  ttcS?: number;
  /** Closest point of approach: when (s) and how close (m, centre to centre). */
  cpa?: { tS: number; missM: number };
  stationary?: boolean;
  /** Inside the bike's predicted path corridor. */
  inPath?: boolean;
  /** Traffic lights only. */
  light?: 'red' | 'yellow' | 'green';
  /** The traffic light that applies to the rider. */
  relevant?: boolean;
  /** The nearest vehicle / cyclist in the bike's path. */
  lead?: boolean;
  /** Seconds to reach the lead vehicle at the current speed. */
  headwayS?: number;
  /** Brake lights just came on (vehicles ahead). */
  braking?: boolean;
  onBicycle?: boolean;
  /** Briefly not detected: shown at its last tracked position. */
  coasting?: boolean;
  /** 0 none, 1 info, 2 caution, 3 danger. */
  threat?: 0 | 1 | 2 | 3;
}

// ----------------------------------------------------------------------------- alerts
export type AlertKind =
  | 'system'   // part of Velo is down / degraded: says which warnings are unavailable
  | 'collision' | 'rear_collision' | 'close_pass' | 'right_hook' | 'oncoming' | 'crossing'
  | 'closing_ahead' | 'in_path' | 'blind_spot' | 'beside' | 'vehicle_behind' | 'cyclist_behind'
  | 'door_zone' | 'vehicle_in_bike_lane' | 'emergency' | 'lead_braking' | 'in_traffic_lane'
  | 'leaving_bike_lane' | 'red_light' | 'yellow_light' | 'green_light' | 'stop_sign' | 'yield_sign'
  | 'no_entry' | 'crosswalk';

export interface Alert {
  id: string;
  kind: AlertKind | string;
  level: Level;
  /** Ready to show / speak, e.g. "Car passing close on your left". */
  text: string;
  /** Where to flash the UI. */
  side?: 'ahead' | 'behind' | 'left' | 'right';
  bearingDeg?: number | null;
  camera: CameraFacing;
  source?: CameraSource;
  /** Detection id, or -1 for situations about the road itself. */
  trackId: number;
  /** Unix seconds when it started. */
  since: number;
}

// ----------------------------------------------------------------------------- road
export interface LaneBoundary {
  type: 'line' | 'edge';     // painted line, or road edge / curb
  distanceM: number;         // sideways distance at 4 m ahead
  points: XZ[];              // 2-20 m ahead
}
export interface Road {
  ok: boolean;
  model?: string;
  laneType?: 'bike_lane' | 'traffic_lane' | 'unknown';
  laneConfidence?: number;
  laneWidthM?: number;
  /** + = right of the lane centre. */
  offsetM?: number;
  leftBoundary?: LaneBoundary;
  rightBoundary?: LaneBoundary;
  /** Predicted path 0-20 m ahead (draw as the ribbon). */
  egoPath?: XZ[];
  /** Seconds the lane type has held (voted over ~2 s). */
  laneStableS?: number;
  /** Wider than any lane: a middle line was missed. */
  multiLane?: boolean;
  /** What confirmed a bike lane, e.g. "bike symbol". */
  laneEvidence?: string;
  /** Camera tilt, self-calibrated from the lane vanishing point. */
  pitchDeg?: number;
  drivableFraction?: number;
  hz?: number;
}

export interface Surroundings {
  zones: Record<'ahead' | 'behind' | 'left' | 'right',
    null | { id: number; label: string; distanceM: number; closingMps?: number | null; threat: number }>;
  lane?: Pick<Road, 'laneType' | 'laneConfidence' | 'laneWidthM' | 'offsetM'>;
}

// ----------------------------------------------------------------------------- park mode
export type SecurityState = 'disarmed' | 'armed' | 'motion' | 'intruder' | 'alarm';
export interface Security {
  state: SecurityState;
  since: number;              // ms
  recording: string | null;   // recording id while recording
  event: string | null;
  facesSaved: number;
  peopleSeen: Record<string, number>;
}

/** /state events: the app's kinds (motion, tamper, crash, pothole) + ride incidents. */
export interface DeviceEvent {
  id: string;                 // unique across reboots ("evt-<ms>")
  kind: 'motion' | 'tamper' | 'crash' | 'pothole' | 'incident' | string;
  ts: number;                 // ms
  reason?: string;            // "person at the bike", "bike moved", ...
  /** Recording id: files at /recordings/<id>/ (front.mp4, rear_trigger.jpg, faces/...). */
  recording?: string;
  snapshots?: string;
  severity?: number;          // g (pothole, crash) or score
  position?: LatLon;
  camera?: CameraSource;
  people?: number;
  // incidents (ride dashcam)
  situation?: AlertKind;
  text?: string;
  clearanceM?: number;
  label?: string;
  objectSpeedKmh?: number;
  ride?: string;
}

export interface Recording {
  id: string;
  started: number;            // ms
  ended?: number;
  reason?: string;
  ride?: string;
  durationS?: number;
  cameras?: CameraSource[];
  files: string[];            // "front.mp4", "front_trigger.jpg", ...
  faces: string[];            // "faces/face_00.jpg", ...
}

export interface Incident {
  id: string; ts: number; situation: AlertKind; text: string; side?: string;
  position: LatLon | null; label?: string; distanceM?: number; objectSpeedKmh?: number;
  closingMps?: number; clearanceM?: number; recording: string;
}
export interface Ride {
  id: string; started: number; ended: number | null; durationS: number; distanceM: number;
  maxSpeedKmh: number; incidents: Incident[]; alertCounts: Record<string, number>;
  closestPassM: number | null; track: [lat: number, lon: number][];
}

// ----------------------------------------------------------------------------- health
export interface HealthPart {
  status: 'ok' | 'degraded' | 'down';
  reason?: string | null;
  fps?: number; hz?: number; latencyMs?: number;
  /** Road cameras: date of the mount calibration (tools/calibrate.py), or false = distances approximate. */
  calibrated?: string | false;
}
/** Safety monitor. When a part is down, a 'system' alert says which warnings are unavailable, and if
 *  perception stops, detections/alerts are emptied (never a frozen "all clear"). */
export interface Health { status: 'ok' | 'degraded' | 'down'; parts: Record<string, HealthPart> }

// ----------------------------------------------------------------------------- /state
export interface CameraStatus { live: boolean; fps: number; status: string; role: CameraRole }

export interface DeviceState {
  mode: Mode;
  alarm: boolean;
  battery?: number;
  speedKmh?: number;
  position?: LatLon | null;
  speaker?: boolean;
  cameras: CameraFacing[];
  detections: Detection[];
  events: DeviceEvent[];
  // extensions
  sources?: CameraSource[];
  roles?: Record<string, CameraRole>;
  cameraStatus?: Record<string, CameraStatus>;
  alerts?: Alert[];
  surroundings?: Surroundings;
  road?: Road;
  security?: Security;
  mcu?: { connected: boolean; imu: boolean; gps: boolean; satellites: number; ring: string | null };
  perf?: Record<string, unknown>;
  health?: Health;
  /** The physical camera /stream?camera=rear shows now (seat webcam while riding, security cam parked). */
  rearCamera?: CameraSource;
  /** Detections from the rear camera that is NOT the one shown as "rear" (so boxes stay on the right picture). */
  otherDetections?: Detection[];
  ts?: number;
}

// ----------------------------------------------------------------------------- client
export class VeloClient {
  constructor(public base: string) {}            // e.g. "http://192.168.1.20:8000"

  private async get<T>(path: string): Promise<T> {
    const r = await fetch(this.base + path, { cache: 'no-store' } as RequestInit);
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.json() as Promise<T>;
  }
  private async post(path: string, body?: unknown): Promise<void> {
    const r = await fetch(this.base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
  }

  state() { return this.get<DeviceState>('/state'); }                 // poll ~4x a second
  events() { return this.get<{ events: DeviceEvent[] }>('/events').then(r => r.events); }
  recordings() { return this.get<{ recordings: Recording[] }>('/recordings').then(r => r.recordings); }
  ride() { return this.get<{ ride: Ride | null }>('/ride').then(r => r.ride); }
  rides() { return this.get<{ rides: Ride[] }>('/rides').then(r => r.rides); }

  lock() { return this.post('/lock'); }                                // park / security mode
  unlock() { return this.post('/unlock'); }                            // ride mode
  setMode(mode: Mode) { return this.post('/mode', { mode }); }
  alarm(active: boolean) { return this.post('/alarm', { active }); }
  chirp() { return this.post('/chirp'); }

  /** MJPEG: use as an <Image>/<img> source (or a WebView on React Native). */
  streamUrl(camera: CameraSource | 'security' = 'front') { return `${this.base}/stream?camera=${camera}`; }
  snapshotUrl(camera: CameraSource = 'front') { return `${this.base}/snapshot?camera=${camera}`; }
  /** e.g. fileUrl(ev.recording!, 'rear_trigger.jpg') for a notification picture. */
  fileUrl(recording: string, file: string) { return `${this.base}/recordings/${recording}/${file}`; }

  /** New events as they happen (server-sent events). Returns a function that stops listening. */
  onEvent(cb: (e: DeviceEvent) => void): () => void {
    const ES = (globalThis as any).EventSource;
    if (!ES) throw new Error('EventSource not available: poll events() instead');
    const es = new ES(this.base + '/events/stream');
    es.onmessage = (m: { data: string }) => cb(JSON.parse(m.data));
    return () => es.close();
  }
}

// ----------------------------------------------------------------------------- helpers
/** The most urgent alert to show as a banner (alerts arrive most severe first). */
export const topAlert = (s: DeviceState) => (s.alerts ?? []).find(a => a.level !== 'info') ?? null;

/** Which sides of the bike to light up (blind spot / car beside you). */
export const litSides = (s: DeviceState) =>
  new Set((s.alerts ?? []).filter(a => a.level !== 'info' && (a.side === 'left' || a.side === 'right')).map(a => a.side!));

/**
 * Chase-camera projection used by the reference HUD (firmware/web/hud.html): a camera 11 m behind
 * and 5.5 m above the bike looking 14 m ahead. World point (x right, y up, z ahead, metres) ->
 * screen pixels, or null if behind the camera. Draw roads, lanes, the path and objects with it.
 */
export function project(x: number, y: number, z: number, W: number, H: number,
                        cam = { y: 5.5, z: -11, lookZ: 14 }): [number, number] | null {
  const dz = cam.lookZ - cam.z, dy = -cam.y, len = Math.hypot(dz, dy);
  const f1 = dy / len, f2 = dz / len, u1 = dz / len, u2 = -dy / len;
  const py = y - cam.y, pz = z - cam.z;
  const zc = py * f1 + pz * f2;
  if (zc < 0.5) return null;
  const yc = py * u1 + pz * u2;
  const focal = W * 0.9;
  return [W / 2 + focal * x / zc, H * 0.42 - focal * yc / zc];
}
