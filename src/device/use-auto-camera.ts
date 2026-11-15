import { useEffect, useRef, useState } from 'react';

import { isCloseVehicle, isNearCyclist, toWorld } from './geometry';
import type { CameraId, Detection } from './types';

import { useRideUi } from '@/ride-ui/ride-ui-provider';

/** Behind is the rider's blind spot, so that is the view shown when nothing needs attention. */
const DEFAULT_CAMERA: CameraId = 'rear';
/** After changing camera, stay on it at least this long so the picture doesn't flicker. */
const HOLD_MS = 3000;

/**
 * The camera that sees whatever most needs attention: the nearest close
 * vehicle, else the nearest nearby cyclist. Null when nothing does.
 */
export function cameraToWatch(detections: Detection[]): CameraId | null {
  const nearest = (matching: Detection[]) =>
    matching.map(toWorld).sort((a, b) => a.distance - b.distance)[0];
  const subject =
    nearest(detections.filter(isCloseVehicle)) ?? nearest(detections.filter(isNearCyclist));
  if (!subject) return null;
  return subject.z > 0 ? 'rear' : 'front';
}

/**
 * Picks which camera picture to show without the rider touching the phone.
 * `pin` overrides the choice for a while (for when stopped, or for a demo).
 */
export function useAutoCamera(cameras: CameraId[], detections: Detection[]) {
  const [shown, setShown] = useState<CameraId>(DEFAULT_CAMERA);
  // The pinned camera lives above the screen so the AI agent can set it too.
  const { pinnedCamera: pinned, pinCamera } = useRideUi();
  const lastSwitch = useRef(0);

  const target = pinned ?? cameraToWatch(detections) ?? DEFAULT_CAMERA;

  useEffect(() => {
    if (target === shown) return;
    // A choice made by hand applies at once; automatic changes respect the hold.
    const wait = pinned ? 0 : Math.max(0, HOLD_MS - (Date.now() - lastSwitch.current));
    const timer = setTimeout(() => {
      lastSwitch.current = Date.now();
      setShown(target);
    }, wait);
    return () => clearTimeout(timer);
  }, [target, shown, pinned]);

  return {
    /** The camera to show. Falls back to whichever camera the device has. */
    camera: cameras.includes(shown) ? shown : cameras[0],
    automatic: pinned === null,
    pin: pinCamera,
  };
}
