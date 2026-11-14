import { useEffect, useState } from 'react';

/** True while `active` is true, and for `ms` afterwards, so things don't blink in and out. */
export function useLinger(active: boolean, ms: number) {
  const [lingering, setLingering] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setLingering(active), active ? 0 : ms);
    return () => clearTimeout(timer);
  }, [active, ms]);

  return active || lingering;
}
