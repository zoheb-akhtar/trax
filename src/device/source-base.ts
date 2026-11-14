import type { DeviceSnapshot } from './types';

/** Tiny observable store that React reads with useSyncExternalStore. */
export class SnapshotStore {
  private listeners = new Set<() => void>();
  protected snapshot: DeviceSnapshot;

  constructor(initial: DeviceSnapshot) {
    this.snapshot = initial;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  protected update(patch: Partial<DeviceSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((l) => l());
  }
}
