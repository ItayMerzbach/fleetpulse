import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../src/core/EventBus';
import { SortedWindow } from '../../src/core/SortedWindow';

describe('SortedWindow', () => {
  it('keeps items sorted by timestamp when inserted out of order and evicts the oldest', () => {
    const w = new SortedWindow<{ timestamp: number }>(3);
    [5, 1, 3, 4].forEach((t) => w.insert({ timestamp: t }));
    expect(w.toArray().map((x) => x.timestamp)).toEqual([3, 4, 5]);
  });

  it('rejects duplicates and items older than a full window', () => {
    const w = new SortedWindow<{ timestamp: number }>(2);
    w.insert({ timestamp: 10 });
    w.insert({ timestamp: 20 });
    expect(w.insert({ timestamp: 20 })).toBe(false);
    expect(w.insert({ timestamp: 5 })).toBe(false);
    expect(w.size).toBe(2);
  });
});

describe('EventBus', () => {
  it('isolates subscribers: one throwing handler does not block the others', () => {
    const onError = vi.fn();
    const bus = new EventBus<{ tick: number }>(onError);
    const good = vi.fn();
    bus.on('tick', () => {
      throw new Error('widget bug');
    });
    bus.on('tick', good);
    bus.emit('tick', 1);
    expect(good).toHaveBeenCalledWith(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops delivery', () => {
    const bus = new EventBus<{ tick: number }>();
    const h = vi.fn();
    const off = bus.on('tick', h);
    off();
    bus.emit('tick', 1);
    expect(h).not.toHaveBeenCalled();
  });
});
