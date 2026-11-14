import { SnapshotStore } from './source-base';
import {
  EMPTY_STATE,
  type CameraId,
  type DeviceMode,
  type DeviceSource,
  type DeviceState,
} from './types';

const POLL_MS = 250;
const TIMEOUT_MS = 1500;

/** "192.168.1.50:8000" -> "http://192.168.1.50:8000" */
export function normalizeHost(host: string) {
  const trimmed = host.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/** Talks to the real Velo device over the local network. See docs/device-api.md. */
export class HttpSource extends SnapshotStore implements DeviceSource {
  private base: string;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(host: string) {
    super({ connection: host.trim() ? 'connecting' : 'offline', state: EMPTY_STATE });
    this.base = normalizeHost(host);
  }

  streamUrlFor(camera: CameraId) {
    return this.base ? `${this.base}/stream?camera=${camera}` : null;
  }

  snapshotUrlFor(camera: CameraId) {
    return this.base ? `${this.base}/snapshot?camera=${camera}` : null;
  }

  start() {
    if (this.running || !this.base) return;
    this.running = true;
    this.poll();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  setMode(mode: DeviceMode) {
    // Reflect it straight away; the next poll confirms what the device did.
    this.update({ state: { ...this.snapshot.state, mode } });
    this.post('/mode', { mode });
  }

  silenceAlarm() {
    this.update({ state: { ...this.snapshot.state, alarm: false } });
    this.post('/alarm', { active: false });
  }

  private async request(path: string, init?: RequestInit) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${this.base}${path}`, { ...init, signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } finally {
      clearTimeout(timeout);
    }
  }

  private post(path: string, body: unknown) {
    this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {
      // The poll loop reports the connection state.
    });
  }

  private async poll() {
    try {
      const res = await this.request('/state');
      const state = parseState(await res.json());
      if (this.running) this.update({ connection: 'connected', state });
    } catch {
      if (this.running && this.snapshot.connection !== 'offline') {
        this.update({ connection: 'offline' });
      }
    }
    if (this.running) this.timer = setTimeout(() => this.poll(), POLL_MS);
  }
}

/** Tolerate missing fields so a half-finished device server still works. */
function parseState(json: any): DeviceState {
  return {
    mode: json?.mode === 'security' ? 'security' : 'ride',
    alarm: Boolean(json?.alarm),
    battery: typeof json?.battery === 'number' ? json.battery : null,
    speedKmh: typeof json?.speedKmh === 'number' ? json.speedKmh : null,
    cameras: json?.cameras?.includes?.('rear')
      ? json.cameras.includes('front')
        ? ['front', 'rear']
        : ['rear']
      : ['front'],
    detections: Array.isArray(json?.detections)
      ? json.detections
          .filter((d: any) => Array.isArray(d?.box) && d.box.length === 4)
          .map((d: any, i: number) => ({
            id: typeof d.id === 'number' ? d.id : i,
            label: String(d.label ?? 'object'),
            confidence: typeof d.confidence === 'number' ? d.confidence : 0,
            box: d.box.map(Number) as [number, number, number, number],
            camera: d.camera === 'rear' ? 'rear' : 'front',
          }))
      : [],
    events: Array.isArray(json?.events)
      ? json.events.map((e: any, i: number) => ({
          id: String(e?.id ?? i),
          kind: e?.kind === 'motion' ? 'motion' : 'tamper',
          ts: typeof e?.ts === 'number' ? e.ts : Date.now(),
        }))
      : [],
  };
}
