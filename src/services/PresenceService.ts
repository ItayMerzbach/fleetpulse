import type { Store } from '../core/store';
import { presenceReducer, type PresenceEvent, type PresenceState } from '../domain/presence';
import type { WsClientMessage } from '../transport/WsConnection';

export interface PresenceServiceOptions {
  /** Re-announce what we're viewing this often. Doubles as a presence heartbeat. */
  heartbeatMs?: number;
  /** Drop dispatchers with no sign of life for this long. */
  ttlMs?: number;
}

/**
 * Collaborative presence on top of a server that only offers join/leave/viewing.
 *
 * The protocol has gaps we close client-side:
 *  - dispatcher_joined is not sent to the joiner, so newcomers don't know who
 *    is already online → we re-announce our viewing state when someone joins,
 *    and periodically (heartbeat).
 *  - leave events may be 10 s late (ghosts) or lost → TTL expiry + the
 *    resurrect-on-activity rule in presenceReducer.
 */
export class PresenceService {
  private viewing: string | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly ttlMs: number;

  constructor(
    private readonly store: Store<PresenceState>,
    private readonly send: (msg: WsClientMessage) => boolean,
    private readonly opts: PresenceServiceOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 45_000;
  }

  start(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      this.announce();
      this.dispatch({ type: 'expire', now: Date.now(), ttlMs: this.ttlMs });
    }, this.opts.heartbeatMs ?? 15_000);
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  dispatch(event: PresenceEvent): void {
    this.store.setState((s) => presenceReducer(s, event));
  }

  setViewing(truckId: string | null): void {
    if (truckId === this.viewing) return;
    this.viewing = truckId;
    this.announce();
  }

  /** Call after (re)registration and whenever another dispatcher joins. */
  announce(): void {
    this.send({ type: 'viewing_truck', truckId: this.viewing });
  }
}
