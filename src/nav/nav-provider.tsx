import { createContext, use, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';

import { NavStore, type NavSnapshot } from './nav-store';

type NavContextValue = NavSnapshot & { nav: NavStore };

const NavContext = createContext<NavContextValue | null>(null);

export function NavProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new NavStore());
  useEffect(() => () => store.dispose(), [store]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  return <NavContext value={{ ...snapshot, nav: store }}>{children}</NavContext>;
}

/** Trip state, plus `nav` for the actions (setDestination, start, stop, ...). */
export function useNav() {
  const value = use(NavContext);
  if (!value) throw new Error('useNav must be used inside <NavProvider>');
  return value;
}
