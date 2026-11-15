import { fetch } from 'expo/fetch';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { proxyUrl } from '@/agent/client';
import { useDevice } from '@/device/device-provider';
import { normalizeHost } from '@/device/http-source';
import { pushToken } from '@/lib/notify';
import { useSettings } from '@/settings/settings-provider';

/** True while the laptop is watching the bike and will push to this phone. */
let pushing = false;
const listeners = new Set<() => void>();

export function laptopPushes() {
  return pushing;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Whether the laptop is watching the bike for this phone, kept up to date. */
export function useLaptopPushes() {
  return useSyncExternalStore(subscribe, laptopPushes, laptopPushes);
}

function setPushing(on: boolean) {
  if (pushing === on) return;
  pushing = on;
  listeners.forEach((l) => l());
}

/** Re-sends the registration this often, in case the agent server was restarted. */
const REFRESH_MS = 60000;

/**
 * Asks the agent server on the laptop to watch the bike and send this phone a push
 * notification when it is moved, so the alert arrives with the app closed and the phone
 * locked. Renders nothing. Only for a real device: the simulated one lives inside the app.
 */
export function PushWatcher() {
  const { loaded, agentUrl, agentToken } = useSettings();
  const { settings } = useDevice();
  const device = settings.source === 'device' ? normalizeHost(settings.host) : '';
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    pushToken().then((t) => current && setToken(t));
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    if (!loaded || !token || !device || !agentUrl.trim()) {
      setPushing(false);
      return;
    }
    let current = true;
    const register = async () => {
      try {
        const response = await fetch(`${proxyUrl(agentUrl)}/v1/watch`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': agentToken.trim() || 'velo-proxy',
          },
          body: JSON.stringify({ pushToken: token, device }),
        });
        if (current) setPushing(response.ok);
      } catch {
        if (current) setPushing(false);
      }
    };
    register();
    const timer = setInterval(register, REFRESH_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [loaded, token, device, agentUrl, agentToken]);

  return null;
}

/** Asks the laptop to send a test push to this phone. */
export async function testPush(agentUrl: string, agentToken: string) {
  try {
    const response = await fetch(`${proxyUrl(agentUrl)}/v1/watch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': agentToken.trim() || 'velo-proxy' },
      body: JSON.stringify({ test: true }),
    });
    const detail = await response.json().catch(() => null);
    return response.ok ? null : (detail?.error?.message ?? `Failed (${response.status}).`);
  } catch {
    return "Couldn't reach the agent server on the laptop.";
  }
}
