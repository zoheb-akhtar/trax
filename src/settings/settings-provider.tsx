import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { createContext, use, useEffect, useState, type ReactNode } from 'react';

import { setSpeakFrom, setVoiceEnabled, type SpeakFrom } from '@/lib/voice';
import { setUnits } from '@/nav/geo';

export type Settings = {
  units: 'km' | 'mi';
  /** Spoken turn directions and warnings */
  voice: boolean;
  /** Where Velo's voice comes from. "bike" falls back to the phone when the bike can't be heard. */
  speakFrom: SpeakFrom;
  /** Who is told after a crash. Stored on this phone only. */
  contactName: string;
  contactPhone: string;
  /** Show the AI agent button */
  agentEnabled: boolean;
  /** Address of the agent proxy (device/agent_proxy.py), which holds the API key */
  agentUrl: string;
  /** Optional shared token the proxy asks for. Not an Anthropic key. */
  agentToken: string;
};

const STORAGE_KEY = 'velo.settings';

/**
 * The agent server runs on the same laptop as the app's development server, so its address
 * is that laptop's, port 8787. On a real phone "localhost" would mean the phone itself.
 */
function laptopAgentUrl() {
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  return `${host || 'localhost'}:8787`;
}

const DEFAULTS: Settings = {
  units: 'km',
  voice: true,
  speakFrom: 'bike',
  contactName: '',
  contactPhone: '',
  agentEnabled: true,
  agentUrl: laptopAgentUrl(),
  agentToken: '',
};

/** An address saved before this default existed, which only ever worked in the simulator. */
const SIMULATOR_ONLY = new Set(['localhost:8787', '127.0.0.1:8787']);

type SettingsContextValue = Settings & {
  /** False until the saved settings have been read; act on nothing before then. */
  loaded: boolean;
  update(patch: Partial<Settings>): void;
};

const SettingsContext = createContext<SettingsContextValue>({
  ...DEFAULTS,
  loaded: false,
  update: () => {},
});

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState(DEFAULTS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (!raw) return;
        const saved: Partial<Settings> = JSON.parse(raw);
        if (saved.agentUrl && SIMULATOR_ONLY.has(saved.agentUrl.trim())) {
          saved.agentUrl = DEFAULTS.agentUrl;
        }
        setSettings({ ...DEFAULTS, ...saved });
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  // Formatting and speech are used far from React, so they read these from module state.
  setUnits(settings.units);
  setVoiceEnabled(settings.voice);
  setSpeakFrom(settings.speakFrom);

  const update = (patch: Partial<Settings>) => {
    setSettings((previous) => {
      const next = { ...previous, ...patch };
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  };

  return <SettingsContext value={{ ...settings, loaded, update }}>{children}</SettingsContext>;
}

export function useSettings() {
  return use(SettingsContext);
}
