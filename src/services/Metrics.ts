import type { MetricsSnapshot } from '../stores/stores';

type Counter = Exclude<
  keyof MetricsSnapshot,
  'sseEventsPerSec' | 'wsLatencyMs' | 'storeCommitsPerSec' | 'heapMb' | 'uptimeSec'
>;

/**
 * Developer-facing observability. Counters are plain mutable numbers (cheap to
 * bump on every SSE event); a 1 Hz snapshot is published to the UI so the
 * metrics panel itself never causes high-frequency renders.
 */
export class Metrics {
  private counters: Record<Counter, number> = {
    sseMessages: 0,
    readingsAccepted: 0,
    readingsLate: 0,
    gpsBatches: 0,
    invalidMessages: 0,
    sseReconnects: 0,
    wsReconnects: 0,
    wsMessages: 0,
    http503: 0,
    httpRetries: 0,
    httpErrors: 0,
    conflicts409: 0,
    handlerErrors: 0,
  };
  private sseTimes: number[] = [];
  private commitTimes: number[] = [];
  private wsLatency: number | null = null;
  private readonly startedAt = Date.now();

  inc(name: Counter, by = 1) {
    this.counters[name] += by;
    if (name === 'sseMessages') this.sseTimes.push(Date.now());
  }

  storeCommit() {
    this.commitTimes.push(Date.now());
  }

  setWsLatency(ms: number) {
    // EWMA so one slow pong doesn't make the number jump around
    this.wsLatency = this.wsLatency === null ? ms : this.wsLatency * 0.7 + ms * 0.3;
  }

  snapshot(now = Date.now()): MetricsSnapshot {
    const windowStart = now - 5000;
    this.sseTimes = this.sseTimes.filter((t) => t >= windowStart);
    this.commitTimes = this.commitTimes.filter((t) => t >= windowStart);
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    return {
      ...this.counters,
      sseEventsPerSec: this.sseTimes.length / 5,
      storeCommitsPerSec: this.commitTimes.length / 5,
      wsLatencyMs: this.wsLatency === null ? null : Math.round(this.wsLatency * 10) / 10,
      heapMb: mem ? Math.round(mem.usedJSHeapSize / 1e5) / 10 : null,
      uptimeSec: Math.round((now - this.startedAt) / 1000),
    };
  }
}
