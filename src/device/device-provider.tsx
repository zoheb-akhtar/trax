import AsyncStorage from '@react-native-async-storage/async-storage';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import {
  createContext,
  use,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import { setBikeSpeaker } from '@/lib/voice';

import { HttpSource } from './http-source';
import { MockSource } from './mock-source';
import type { CameraId, DeviceMode, DeviceSnapshot } from './types';

export type DeviceSettings = {
  source: 'simulated' | 'device';
  /** IP or hostname of the Velo device, with optional port */
  host: string;
};

type DeviceContextValue = DeviceSnapshot & {
  settings: DeviceSettings;
  updateSettings(next: DeviceSettings): void;
  streamUrlFor(camera: CameraId): string | null;
  snapshotUrlFor(camera: CameraId): string | null;
  setMode(mode: DeviceMode): void;
  silenceAlarm(): void;
  soundAlarm(): void;
  /** Only available when simulating */
  simulateTamper: (() => void) | null;
  simulateCrash: (() => void) | null;
  chirp(): void;
  /** Says a line through the bike's speaker; false if there is none or it can't be reached. */
  sayOnBike(text: string, urgent: boolean): Promise<boolean>;
  /** Plays a recording through the bike's speaker. */
  playOnBike(audio: Uint8Array): Promise<boolean>;
  /** Whether the bike's speaker can be used right now */
  hasSpeaker: boolean;
};

const STORAGE_KEY = 'velo.device-settings';
const KEEP_AWAKE_TAG = 'velo-ride';
const DEFAULT_SETTINGS: DeviceSettings = { source: 'simulated', host: '' };

const DeviceContext = createContext<DeviceContextValue | null>(null);

export function DeviceProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<DeviceSettings | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) =>
        setSettings(raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS),
      )
      .catch(() => setSettings(DEFAULT_SETTINGS));
  }, []);

  if (!settings) return null;

  return (
    <ConnectedProvider
      settings={settings}
      updateSettings={(next) => {
        setSettings(next);
        AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => {});
      }}
    >
      {children}
    </ConnectedProvider>
  );
}

function ConnectedProvider({
  settings,
  updateSettings,
  children,
}: {
  settings: DeviceSettings;
  updateSettings(next: DeviceSettings): void;
  children: ReactNode;
}) {
  const { source: kind, host } = settings;
  const source = useMemo(
    () => (kind === 'simulated' ? new MockSource() : new HttpSource(host)),
    [kind, host],
  );

  useEffect(() => {
    source.start();
    return () => source.stop();
  }, [source]);

  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);

  // A phone that locks mid-ride stops showing turns and warnings, so keep the screen on.
  const riding = snapshot.state.mode === 'ride';
  useEffect(() => {
    if (!riding) return;
    activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    return () => {
      deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    };
  }, [riding]);

  // While riding, the rider is at the bike, so Velo talks to them through its speaker. While
  // parked the owner is elsewhere: what Velo says to them stays on the phone, and only the
  // deliberate warnings to whoever is at the bike (sayOnBike, playOnBike) use the speaker.
  const hasSpeaker = snapshot.connection === 'connected' && snapshot.state.speaker;
  const speakToRider = hasSpeaker && riding;
  useEffect(() => {
    setBikeSpeaker(speakToRider ? (text, urgent) => source.say(text, urgent) : null);
    return () => setBikeSpeaker(null);
  }, [speakToRider, source]);

  const value: DeviceContextValue = {
    ...snapshot,
    settings,
    updateSettings,
    streamUrlFor: (camera) => source.streamUrlFor(camera),
    snapshotUrlFor: (camera) => source.snapshotUrlFor(camera),
    setMode: (mode) => source.setMode(mode),
    silenceAlarm: () => source.silenceAlarm(),
    soundAlarm: () => source.soundAlarm(),
    simulateTamper: source instanceof MockSource ? () => source.simulateTamper() : null,
    simulateCrash: source instanceof MockSource ? () => source.simulateCrash() : null,
    chirp: () => source.chirp(),
    sayOnBike: (text, urgent) => source.say(text, urgent),
    playOnBike: (audio) => source.play(audio),
    hasSpeaker,
  };

  return <DeviceContext value={value}>{children}</DeviceContext>;
}

export function useDevice() {
  const value = use(DeviceContext);
  if (!value) throw new Error('useDevice must be used inside <DeviceProvider>');
  return value;
}
