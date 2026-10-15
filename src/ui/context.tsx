import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { FleetPulse } from '../app/createFleetPulse';
import type { Store } from '../core/store';

const FleetPulseContext = createContext<FleetPulse | null>(null);

export function FleetPulseProvider({ app, children }: { app: FleetPulse; children: ReactNode }) {
  return <FleetPulseContext.Provider value={app}>{children}</FleetPulseContext.Provider>;
}

export function useFleetPulse(): FleetPulse {
  const app = useContext(FleetPulseContext);
  if (!app) throw new Error('useFleetPulse must be used inside <FleetPulseProvider>');
  return app;
}

/**
 * Subscribe to a slice of a store. The selector must return a stable reference
 * when nothing relevant changed (select existing objects; derive with useMemo),
 * so a telemetry tick for truck_3 doesn't re-render truck_9's row.
 */
export function useStore<S, T>(store: Store<S>, selector: (s: S) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}
