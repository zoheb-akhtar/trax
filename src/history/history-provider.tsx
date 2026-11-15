import { createContext, use, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';

import { useDevice } from '@/device/device-provider';
import { useNav } from '@/nav/nav-provider';

import { RideHistory, type RideHistorySnapshot } from './ride-history';

type HistoryContextValue = RideHistorySnapshot & { deleteRide(id: string): void };

const HistoryContext = createContext<HistoryContextValue | null>(null);

/** Records rides in the background from the device's state, and provides the list of them. */
export function HistoryProvider({ children }: { children: ReactNode }) {
  const [history] = useState(() => new RideHistory());
  const { state, snapshotUrlFor } = useDevice();
  const { navigating, destination, position } = useNav();
  const snapshot = useSyncExternalStore(history.subscribe, history.getSnapshot, history.getSnapshot);

  useEffect(() => {
    history.load();
  }, [history]);

  const destinationName = navigating ? (destination?.name ?? null) : null;
  useEffect(() => {
    history.update({
      mode: state.mode,
      speedKmh: state.speedKmh,
      detections: state.detections,
      cameras: state.cameras,
      snapshotUrlFor,
      destination: destinationName,
      position,
    });
  });

  return (
    <HistoryContext value={{ ...snapshot, deleteRide: (id) => history.delete(id) }}>
      {children}
    </HistoryContext>
  );
}

export function useRideHistory() {
  const value = use(HistoryContext);
  if (!value) throw new Error('useRideHistory must be used inside <HistoryProvider>');
  return value;
}
