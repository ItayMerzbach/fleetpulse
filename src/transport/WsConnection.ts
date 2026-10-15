import { WsServerMessageSchema } from '../domain/schemas';
import type { DispatcherIdentity, WsServerMessage } from '../domain/types';
import { createBackoff } from './backoff';
import type { ConnectionStatus } from './SseConnection';

export type WsClientMessage =
  | { type: 'register_dispatcher'; dispatcherId: string; name: string }
  | { type: 'ping' }
  | { type: 'viewing_truck'; truckId: string | null };

export interface WsConnectionOptions {
  url: string;
  identity: DispatcherIdentity;
  onMessage: (msg: WsServerMessage) => void;
  onInvalid?: (raw: string, reason: string) => void;
  onStatus?: (status: ConnectionStatus) => void;
  /** Fired after (re)registration so presence can re-announce itself. */
  onRegistered?: (isReconnect: boolean) => void;
  onLatency?: (rttMs: number) => void;
  onReconnect?: () => void;
  pingIntervalMs?: number;
  createWebSocket?: (url: string) => WebSocket;
}

/**
 * WebSocket lifecycle: register on open, application-level ping/pong for
 * latency + liveness (a half-open TCP connection never fires `close`),
 * reconnect with backoff, and never throw from send() when disconnected.
 */
export class WsConnection {
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = 'idle';
  private backoff = createBackoff(1000, 30_000);
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingSentAt: number | null = null;
  private stopped = true;
  private hasRegisteredBefore = false;

  constructor(private readonly opts: WsConnectionOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopPing();
    this.teardownSocket();
    this.setStatus('closed');
  }

  /** Returns false when the message could not be sent (caller decides whether to care). */
  send(msg: WsClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  get isOpen(): boolean {
    return this.status === 'open';
  }

  private connect() {
    this.setStatus(this.hasRegisteredBefore ? 'reconnecting' : 'connecting');
    const ws = (this.opts.createWebSocket ?? ((u) => new WebSocket(u)))(this.opts.url);
    this.ws = ws;
    ws.onopen = () => {
      this.send({ type: 'register_dispatcher', dispatcherId: this.opts.identity.id, name: this.opts.identity.name });
    };
    ws.onmessage = (ev: MessageEvent) => this.handleRaw(String(ev.data));
    ws.onclose = () => this.scheduleReconnect();
    ws.onerror = () => {
      /* onclose always follows; reconnect happens there */
    };
  }

  private handleRaw(raw: string) {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.opts.onInvalid?.(raw, 'invalid JSON');
      return;
    }
    const parsed = WsServerMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.opts.onInvalid?.(raw, parsed.error.issues[0]?.message ?? 'schema mismatch');
      return;
    }
    const msg = parsed.data;
    if (msg.type === 'registered') {
      this.backoff.reset();
      this.setStatus('open');
      this.startPing();
      const isReconnect = this.hasRegisteredBefore;
      this.hasRegisteredBefore = true;
      if (isReconnect) this.opts.onReconnect?.();
      this.opts.onRegistered?.(isReconnect);
    } else if (msg.type === 'pong') {
      if (this.pingSentAt !== null) this.opts.onLatency?.(performance.now() - this.pingSentAt);
      this.pingSentAt = null;
    }
    this.opts.onMessage(msg);
  }

  private startPing() {
    this.stopPing();
    const interval = this.opts.pingIntervalMs ?? 10_000;
    this.pingTimer = setInterval(() => {
      if (this.pingSentAt !== null && performance.now() - this.pingSentAt > interval * 2) {
        // Two intervals without pong: the socket is a zombie. Force a reconnect.
        this.teardownSocket();
        this.scheduleReconnect();
        return;
      }
      if (this.pingSentAt === null && this.send({ type: 'ping' })) this.pingSentAt = performance.now();
    }, interval);
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.pingSentAt = null;
  }

  private scheduleReconnect() {
    this.stopPing();
    if (this.stopped || this.reconnectTimer) return;
    this.teardownSocket();
    this.setStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connect();
    }, this.backoff.next());
  }

  private teardownSocket() {
    if (!this.ws) return;
    this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null;
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close();
    this.ws = null;
  }

  private setStatus(s: ConnectionStatus) {
    if (s === this.status) return;
    this.status = s;
    this.opts.onStatus?.(s);
  }
}
