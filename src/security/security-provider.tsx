import { createContext, use, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';

import { useDevice } from '@/device/device-provider';

import { SecurityLog, type SecuritySnapshot } from './security-log';

type SecurityContextValue = SecuritySnapshot & {
  deleteEntry(id: string): void;
  /** Sets Velo's alarm off from the phone, and notes it in the log. */
  soundAlarm(): void;
};

const SecurityContext = createContext<SecurityContextValue | null>(null);

/** Keeps the security log up to date from the device's state, and provides it. */
export function SecurityProvider({ children }: { children: ReactNode }) {
  const [log] = useState(() => new SecurityLog());
  const { state, connection, snapshotUrlFor, soundAlarm } = useDevice();
  const snapshot = useSyncExternalStore(log.subscribe, log.getSnapshot, log.getSnapshot);

  useEffect(() => {
    log.load();
  }, [log]);

  useEffect(() => {
    log.update({
      tracking: connection === 'connected' || connection === 'simulated',
      mode: state.mode,
      events: state.events,
      cameras: state.cameras,
      snapshotUrlFor,
    });
  });

  return (
    <SecurityContext
      value={{
        ...snapshot,
        deleteEntry: (id) => log.delete(id),
        soundAlarm: () => {
          log.noteSiren();
          soundAlarm();
        },
      }}>
      {children}
    </SecurityContext>
  );
}

export function useSecurity() {
  const value = use(SecurityContext);
  if (!value) throw new Error('useSecurity must be used inside <SecurityProvider>');
  return value;
}
