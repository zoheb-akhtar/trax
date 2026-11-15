import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { File } from 'expo-file-system';
import { fetch } from 'expo/fetch';
import { useEffect, useRef, type RefObject } from 'react';

import { proxyUrl } from './client';

export type HeardResult =
  | { ok: true; text: string }
  /**
   * denied: no microphone permission. nothing: no words were heard.
   * unavailable: the proxy can't turn speech into text (not set up, or unreachable).
   */
  | { ok: false; reason: 'denied' | 'nothing' | 'unavailable' | 'failed' };

/**
 * Whether the proxy can turn speech into text right now. Asked on every tap (it is a quick
 * local request), so voice starts working as soon as the proxy does, with no app restart.
 */
export async function proxyCanHear(address: string) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 1200);
  try {
    const response = await fetch(`${proxyUrl(address)}/health`, { signal: abort.signal });
    return response.ok && (await response.json()).speech === 'ready';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export type RecorderControl = {
  /** Stop recording and use what was said. */
  finish(): void;
  /** Stop recording and throw it away. */
  cancel(): void;
};

/** Stop this long after the owner goes quiet. */
const QUIET_MS = 1100;
/** Give up if nothing has been said by now. */
const NO_SPEECH_MS = 6000;
const LONGEST_MS = 8000;
/** A voice is at least this much louder (in decibels) than the room at its quietest. */
const SPEECH_ABOVE_FLOOR_DB = 14;

type Props = {
  /** Address of the agent proxy, which does the speech-to-text */
  address: string;
  token: string;
  /** Filled in with the controls while recording */
  controlRef: RefObject<RecorderControl | null>;
  /** Called once recording has stopped and the words are being worked out */
  onStopped(): void;
  onDone(result: HeardResult): void;
};

/**
 * Records one spoken question and has the proxy turn it into text. Mounted only while
 * listening; renders nothing. It stops by itself when the owner stops talking.
 *
 * This is how Velo hears in Expo Go, where on-device speech recognition isn't available.
 */
export function VoiceRecorder({ address, token, controlRef, onStopped, onDone }: Props) {
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true });
  const level = useAudioRecorderState(recorder, 150);
  const run = useRef({
    recording: false,
    ended: false,
    /** The quietest and loudest levels so far, in decibels (0 is the loudest possible) */
    floor: 0,
    peak: -160,
    spoke: false,
    lastLoud: 0,
  });

  const end = async (keep: boolean) => {
    const state = run.current;
    if (state.ended) return;
    state.ended = true;
    controlRef.current = null;
    try {
      if (state.recording) await recorder.stop();
      // Back to playback, so the spoken answer comes out of the loudspeaker at full volume.
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      const uri = recorder.uri;
      if (!keep || !state.recording || !uri) return onDone({ ok: false, reason: 'nothing' });

      onStopped();
      const response = await fetch(`${proxyUrl(address)}/v1/transcribe`, {
        method: 'POST',
        headers: { 'content-type': 'audio/m4a', 'x-api-key': token.trim() || 'velo-proxy' },
        body: await new File(uri).bytes(),
      });
      // 404: an older proxy without speech-to-text. 501/503: it has none, or is still loading it.
      if (response.status === 404 || response.status === 501 || response.status === 503) {
        return onDone({ ok: false, reason: 'unavailable' });
      }
      if (!response.ok) return onDone({ ok: false, reason: 'failed' });
      const text = String((await response.json()).text ?? '').trim();
      onDone(text ? { ok: true, text } : { ok: false, reason: 'nothing' });
    } catch {
      // Most often the phone can't reach the proxy at all.
      onDone({ ok: false, reason: 'unavailable' });
    }
  };

  useEffect(() => {
    const state = run.current;
    controlRef.current = { finish: () => end(true), cancel: () => end(false) };
    (async () => {
      try {
        const permission = await AudioModule.requestRecordingPermissionsAsync();
        if (!permission.granted) {
          state.ended = true;
          controlRef.current = null;
          return onDone({ ok: false, reason: 'denied' });
        }
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
        await recorder.prepareToRecordAsync();
        if (state.ended) return;
        recorder.record();
        state.recording = true;
        state.lastLoud = Date.now();
      } catch {
        state.ended = true;
        controlRef.current = null;
        onDone({ ok: false, reason: 'failed' });
      }
    })();
    return () => {
      // Unmounted mid-recording (e.g. the app reloaded): stop the microphone.
      if (state.recording && !state.ended) {
        state.ended = true;
        recorder.stop().catch(() => {});
      }
    };
    // Runs once: this component exists for a single recording.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stop when the owner has finished talking.
  const { metering, durationMillis } = level;
  useEffect(() => {
    const state = run.current;
    if (!state.recording || state.ended) return;
    const now = Date.now();
    if (typeof metering === 'number') {
      if (metering < state.floor) state.floor = metering;
      if (metering > state.peak) state.peak = metering;
      if (state.peak > state.floor + SPEECH_ABOVE_FLOOR_DB) state.spoke = true;
      // "Still talking" means louder than halfway between the room and the voice, so a noisy
      // room does not keep the microphone open after the owner has stopped.
      if (!state.spoke || metering > (state.floor + state.peak) / 2) state.lastLoud = now;
      if (state.spoke && now - state.lastLoud > QUIET_MS) end(true);
      else if (!state.spoke && durationMillis > NO_SPEECH_MS) end(true);
    }
    if (durationMillis > LONGEST_MS) end(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metering, durationMillis]);

  return null;
}
