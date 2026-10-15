type Handler<T> = (payload: T) => void;

/**
 * Minimal typed pub/sub. Handlers are isolated from each other: a throwing
 * subscriber is reported via `onHandlerError` and never prevents delivery to
 * the remaining subscribers (one broken widget must not stop the pipeline).
 */
export class EventBus<Events extends object> {
  private handlers = new Map<keyof Events, Set<Handler<never>>>();

  constructor(private onHandlerError: (type: keyof Events, err: unknown) => void = defaultErrorHandler) {}

  on<K extends keyof Events>(type: K, handler: Handler<Events[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as Handler<never>);
    return () => {
      set.delete(handler as Handler<never>);
    };
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        (handler as Handler<Events[K]>)(payload);
      } catch (err) {
        this.onHandlerError(type, err);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}

function defaultErrorHandler(type: PropertyKey, err: unknown) {
  console.error(`[EventBus] handler for "${String(type)}" threw`, err);
}
