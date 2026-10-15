/**
 * Bounded collection kept sorted by timestamp.
 *
 * - Appending in-order data is O(1) amortised (the common case: live telemetry).
 * - Late / out-of-order data is inserted at its correct position (binary search),
 *   so charts and trails always reflect event time, never arrival time.
 * - When full, the OLDEST item is evicted — this is the data window that keeps
 *   memory flat when the dashboard runs for hours.
 */
export class SortedWindow<T extends { timestamp: number }> {
  private items: T[] = [];

  constructor(private readonly capacity: number) {
    if (capacity < 1) throw new Error('capacity must be >= 1');
  }

  get size(): number {
    return this.items.length;
  }

  /** Returns false if the item was rejected (older than everything in a full window, or a duplicate timestamp). */
  insert(item: T): boolean {
    const items = this.items;
    if (items.length === this.capacity && item.timestamp < items[0].timestamp) return false;

    let idx: number;
    if (items.length === 0 || item.timestamp > items[items.length - 1].timestamp) {
      idx = items.length;
    } else {
      idx = this.lowerBound(item.timestamp);
      if (idx < items.length && items[idx].timestamp === item.timestamp) return false;
    }
    items.splice(idx, 0, item);
    if (items.length > this.capacity) items.shift();
    return true;
  }

  latest(): T | undefined {
    return this.items[this.items.length - 1];
  }

  oldest(): T | undefined {
    return this.items[0];
  }

  toArray(): T[] {
    return this.items.slice();
  }

  clear(): void {
    this.items = [];
  }

  private lowerBound(ts: number): number {
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.items[mid].timestamp < ts) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
