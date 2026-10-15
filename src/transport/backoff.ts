export interface Backoff {
  next(): number;
  reset(): void;
  readonly attempts: number;
}

/** Exponential backoff with "equal jitter": half fixed, half random, capped. */
export function createBackoff(baseMs = 1000, maxMs = 30_000, random = Math.random): Backoff {
  let attempts = 0;
  return {
    next() {
      const exp = Math.min(maxMs, baseMs * 2 ** attempts++);
      return Math.round(exp / 2 + random() * (exp / 2));
    },
    reset() {
      attempts = 0;
    },
    get attempts() {
      return attempts;
    },
  };
}
