import { createContext, use, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';

import { useDevice } from '@/device/device-provider';
import { useSecurity } from '@/security/security-provider';

import { ParkingLog, type ParkingSnapshot } from './parking-log';
import { sampleParking } from './sample-parking';

type ParkingContextValue = ParkingSnapshot & {
  clearParking(): void;
  /** Fills the parking log with a believable week, to go with the sample rides. */
  loadSampleParking(): void;
};

const ParkingContext = createContext<ParkingContextValue | null>(null);

/** Records where the bike is left, for how long and how busy the spot is, and provides it. */
export function ParkingProvider({ children }: { children: ReactNode }) {
  const [log] = useState(() => new ParkingLog());
  const { state, connection } = useDevice();
  const { parked } = useSecurity();
  const snapshot = useSyncExternalStore(log.subscribe, log.getSnapshot, log.getSnapshot);

  useEffect(() => {
    log.load();
  }, [log]);

  useEffect(() => {
    log.update({
      parked,
      mode: state.mode,
      tracking: connection === 'connected' || connection === 'simulated',
      detections: state.detections,
    });
  });

  return (
    <ParkingContext
      value={{
        ...snapshot,
        clearParking: () => log.clear(),
        loadSampleParking: () => log.seed(sampleParking(Date.now())),
      }}>
      {children}
    </ParkingContext>
  );
}

export function useParking() {
  const value = use(ParkingContext);
  if (!value) throw new Error('useParking must be used inside <ParkingProvider>');
  return value;
}
