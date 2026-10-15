export type Listener = () => void;

export interface Store<S> {
  getState(): S;
  setState(updater: S | ((prev: S) => S)): void;
  subscribe(listener: Listener): () => void;
}

export interface StoreOptions {
  /**
   * 'sync'  — notify subscribers immediately (tests, low-frequency stores).
   * 'frame' — coalesce all updates within one animation frame into a single
   *           notification. Used for high-frequency telemetry so a GPS batch of
   *           30 readings costs one render, not 30.
   */
  notify?: 'sync' | 'frame';
}

/**
 * Tiny external store compatible with React's useSyncExternalStore.
 * State is treated as immutable: updaters must return new objects for the
 * parts that changed so selectors can rely on reference equality.
 */
export function createStore<S>(initial: S, options: StoreOptions = {}): Store<S> {
  let state = initial;
  const listeners = new Set<Listener>();
  let scheduled = false;
  const useFrame = options.notify === 'frame' && typeof requestAnimationFrame === 'function';

  const flush = () => {
    scheduled = false;
    for (const l of [...listeners]) l();
  };

  return {
    getState: () => state,
    setState(updater) {
      const next = typeof updater === 'function' ? (updater as (p: S) => S)(state) : updater;
      if (Object.is(next, state)) return;
      state = next;
      if (!useFrame) return flush();
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(flush);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
