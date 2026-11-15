import { createContext, use, useEffect, useState, type ReactNode } from 'react';

import type { CameraView } from '@/device/types';

/** A camera chosen by hand (or by the agent) stays this long, then the choice returns to automatic. */
const PIN_MS = 20000;

type RideUi = {
  /** Show everything on the Ride screen instead of the quiet riding layout */
  fullView: boolean;
  setFullView(on: boolean): void;
  pinnedCamera: CameraView | null;
  pinCamera(camera: CameraView | null): void;
};

const RideUiContext = createContext<RideUi | null>(null);

/**
 * View choices for the Ride screen, held above it so the AI agent can change them
 * ("show me the rear camera") as well as the rider.
 */
export function RideUiProvider({ children }: { children: ReactNode }) {
  const [fullView, setFullView] = useState(false);
  const [pinnedCamera, pinCamera] = useState<CameraView | null>(null);

  useEffect(() => {
    if (!pinnedCamera) return;
    const timer = setTimeout(() => pinCamera(null), PIN_MS);
    return () => clearTimeout(timer);
  }, [pinnedCamera]);

  return (
    <RideUiContext value={{ fullView, setFullView, pinnedCamera, pinCamera }}>
      {children}
    </RideUiContext>
  );
}

export function useRideUi() {
  const value = use(RideUiContext);
  if (!value) throw new Error('useRideUi must be used inside <RideUiProvider>');
  return value;
}
