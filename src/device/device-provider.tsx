import AsyncStorage from '@react-native-async-storage/async-storage';
import { readStored } from '@/lib/storage';
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
  /** IP or hostname of the Trax device, with optional port */
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
  /** Only with a device that has test routes (the laptop test server); false if it has none. */
  simulateCar: (() => Promise<boolean>) | null;
  /** Pretends the bike hit a pothole (simulated device or the laptop test server). */
  simulatePothole: (() => void) | null;
  /** Whether the connected device is driven through its test routes rather than built in */
  testRoutes: boolean;
  chirp(): void;
  /** Says a line through the bike's speaker; false if there is none or it can't be reached. */
  sayOnBike(text: string, urgent: boolean): Promise<boolean>;
  /** Plays a recording through the bike's speaker. */
  playOnBike(audio: Uint8Array): Promise<boolean>;
  /** Whether the bike's speaker can be used right now */
  hasSpeaker: boolean;
};

const STORAGE_KEY = 'trax.device-settings';
const KEEP_AWAKE_TAG = 'trax-ride';
const DEFAULT_SETTINGS: DeviceSettings = { source: 'simulated', host: '' };

const DeviceContext = createContext<DeviceContextValue | null>(null);

export function DeviceProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<DeviceSettings | null>(null);

  useEffect(() => {
    readStored(STORAGE_KEY)
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

  // While riding, the rider is at the bike, so Trax talks to them through its speaker. While
  // parked the owner is elsewhere: what Trax says to them stays on the phone, and only the
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
    simulateTamper:
      source instanceof MockSource
        ? () => source.simulateTamper()
        : source instanceof HttpSource
          ? () => {
              // The test server arms itself when told the bike was moved; a real device ignores it.
              source.debug('tamper');
            }
          : null,
    simulateCrash:
      source instanceof MockSource
        ? () => source.simulateCrash()
        : source instanceof HttpSource
          ? () => {
              source.debug('crash');
            }
          : null,
    simulateCar: source instanceof HttpSource ? () => source.debug('car') : null,
    simulatePothole:
      source instanceof MockSource
        ? () => source.simulatePothole()
        : source instanceof HttpSource
          ? () => {
              source.debug('pothole');
            }
          : null,
    testRoutes: source instanceof HttpSource,
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
