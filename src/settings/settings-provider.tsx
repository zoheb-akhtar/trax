import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, use, useEffect, useState, type ReactNode } from 'react';

import { setVoiceEnabled } from '@/lib/voice';
import { setUnits } from '@/nav/geo';

export type Settings = {
  units: 'km' | 'mi';
  /** Spoken turn directions and warnings */
  voice: boolean;
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
const DEFAULTS: Settings = { units: 'km', voice: true, contactName: '',
  contactPhone: '',
  agentEnabled: true,
  agentUrl: 'localhost:8787',
  agentToken: '',
};

type SettingsContextValue = Settings & { update(patch: Partial<Settings>): void };

const SettingsContext = createContext<SettingsContextValue>({ ...DEFAULTS, update: () => {} });

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState(DEFAULTS);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => raw && setSettings({ ...DEFAULTS, ...JSON.parse(raw) }))
      .catch(() => {});
  }, []);

  // Formatting and speech are used far from React, so they read these from module state.
  setUnits(settings.units);
  setVoiceEnabled(settings.voice);

  const update = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => {});
  };

  return <SettingsContext value={{ ...settings, update }}>{children}</SettingsContext>;
}

export function useSettings() {
  return use(SettingsContext);
}
