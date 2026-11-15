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
/** A voice recording is bigger than a status request, and the board has to play it. */
const PLAY_TIMEOUT_MS = 8000;
/** Wi-Fi drops the odd reply; only this many failures in a row count as offline. */
const FAILURES_BEFORE_OFFLINE = 3;
/**
 * After the app changes the mode or alarm, polls that disagree are ignored for this long:
 * a reply already on its way may describe the moment before the change.
 */
const SETTLE_MS = 2000;
/** Detections the model is less sure of than this are ignored. */
const MIN_CONFIDENCE = 0.5;
/** Other names detectors use for the labels the app understands. */
const LABEL_ALIASES: Record<string, string> = { motorbike: 'motorcycle', bike: 'bicycle' };

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
  private failures = 0;
  private pending: { mode?: DeviceMode; alarm?: boolean; until: number } = { until: 0 };

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
    // Reflect it straight away; polls that follow confirm what the device did.
    this.pending = { ...this.pending, mode, until: Date.now() + SETTLE_MS };
    this.update({ state: { ...this.snapshot.state, mode } });
    this.post('/mode', { mode });
  }

  silenceAlarm() {
    this.pending = { ...this.pending, alarm: false, until: Date.now() + SETTLE_MS };
    this.update({ state: { ...this.snapshot.state, alarm: false } });
    this.post('/alarm', { active: false });
  }

  soundAlarm() {
    this.pending = { ...this.pending, alarm: true, until: Date.now() + SETTLE_MS };
    this.update({ state: { ...this.snapshot.state, alarm: true } });
    this.post('/alarm', { active: true });
  }

  chirp() {
    this.post('/chirp', {});
  }

  /**
   * Asks the device to pretend something happened, through the test server's /debug routes.
   * A real device has no such routes, so this resolves false there.
   */
  async debug(what: 'tamper' | 'crash' | 'car') {
    try {
      await this.request(`/debug/${what}`, { method: 'POST' });
      return true;
    } catch {
      return false;
    }
  }

  async say(text: string, urgent: boolean) {
    if (!this.snapshot.state.speaker || this.snapshot.connection !== 'connected') return false;
    try {
      await this.request('/say', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, urgent }),
      });
      return true;
    } catch {
      return false;
    }
  }

  async play(audio: Uint8Array) {
    if (!this.snapshot.state.speaker || this.snapshot.connection !== 'connected') return false;
    try {
      await this.request('/play', {
        method: 'POST',
        headers: { 'Content-Type': 'audio/m4a' },
        body: audio as unknown as BodyInit,
      }, PLAY_TIMEOUT_MS);
      return true;
    } catch {
      return false;
    }
  }

  private async request(path: string, init?: RequestInit, timeoutMs = TIMEOUT_MS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
      let state = parseState(await res.json());
      if (Date.now() < this.pending.until) {
        state = {
          ...state,
          mode: this.pending.mode ?? state.mode,
          alarm: this.pending.alarm ?? state.alarm,
        };
      } else {
        this.pending = { until: 0 };
      }
      this.failures = 0;
      if (this.running) this.update({ connection: 'connected', state });
    } catch {
      this.failures += 1;
      if (
        this.running &&
        this.failures >= FAILURES_BEFORE_OFFLINE &&
        this.snapshot.connection !== 'offline'
      ) {
        // What the device last saw is no longer true: drop it, so no warning is left showing
        // and no ride keeps adding distance at a frozen speed. Mode and history are kept.
        this.update({
          connection: 'offline',
          state: { ...this.snapshot.state, detections: [], speedKmh: null },
        });
      }
    }
    if (this.running) this.timer = setTimeout(() => this.poll(), POLL_MS);
  }
}

/** A stable number for a detection's id, whatever type the detector sends. */
function detectionId(raw: unknown, index: number) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
    let hash = 0;
    for (let i = 0; i < raw.length; i++) hash = (hash * 31 + raw.charCodeAt(i)) | 0;
    return Math.abs(hash) + 1_000_000;
  }
  return -1 - index;
}

/**
 * An event's id as the app keeps it. Device counters often restart at 1 after a reboot, so the
 * time is part of it: "evt-1" today and "evt-1" after a reboot are different events.
 */
function eventId(e: any, index: number) {
  const id = e?.id != null && e.id !== '' ? String(e.id) : null;
  const ts = typeof e?.ts === 'number' ? e.ts : null;
  if (id && ts) return `${id}@${ts}`;
  if (id) return id;
  if (ts) return `${e?.kind ?? 'event'}@${ts}`;
  return `event-${index}`;
}

/** Tolerate missing fields so a half-finished device server still works. */
function parseState(json: any): DeviceState {
  const cameras: CameraId[] = json?.cameras?.includes?.('rear')
    ? json.cameras.includes('front')
      ? ['front', 'rear']
      : ['rear']
    : ['front'];
  // With one camera fitted, a detection that doesn't say which camera saw it came from that one.
  const defaultCamera: CameraId = cameras.length === 1 ? cameras[0] : 'front';
  return {
    mode: json?.mode === 'security' ? 'security' : 'ride',
    alarm: Boolean(json?.alarm),
    battery: typeof json?.battery === 'number' ? json.battery : null,
    speedKmh: typeof json?.speedKmh === 'number' ? json.speedKmh : null,
    speaker: json?.speaker === true,
    position:
      typeof json?.position?.lat === 'number' && typeof json?.position?.lon === 'number'
        ? { lat: json.position.lat, lon: json.position.lon }
        : null,
    cameras,
    detections: Array.isArray(json?.detections)
      ? json.detections
          .filter((d: any) => Array.isArray(d?.box) && d.box.length === 4)
          .filter((d: any) => typeof d.confidence !== 'number' || d.confidence >= MIN_CONFIDENCE)
          .map((d: any, i: number) => {
            const label = String(d.label ?? 'object').toLowerCase();
            return {
              id: detectionId(d.id, i),
              label: LABEL_ALIASES[label] ?? label,
              confidence: typeof d.confidence === 'number' ? d.confidence : 1,
              box: d.box.map(Number) as [number, number, number, number],
              camera: d.camera === 'rear' || d.camera === 'front' ? d.camera : defaultCamera,
            };
          })
      : [],
    events: Array.isArray(json?.events)
      ? json.events
          // Kinds the app doesn't know are ignored rather than guessed at.
          .filter((e: any) => e?.kind === 'tamper' || e?.kind === 'motion' || e?.kind === 'crash')
          .map((e: any, i: number) => ({
            id: eventId(e, i),
            kind: e.kind,
            ts: typeof e?.ts === 'number' ? e.ts : Date.now(),
          }))
      : [],
  };
}
