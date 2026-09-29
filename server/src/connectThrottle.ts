/**
 * Per-device mux reconnect throttle. A device that opens more than `limit`
 * mux sockets to one share inside `windowMs` gets 429 at the upgrade, before
 * any room is joined, so a looping client costs one HTTP response instead of a
 * full share sync plus audit rows. Rejections do not count toward the window,
 * so the lockout ends as soon as the window drains (at most `windowMs`); a
 * client with ordinary backoff never reaches the limit.
 */
export interface ThrottleDecision {
  allowed: boolean;
  /** Seconds until the oldest counted connect leaves the window. */
  retryAfterSec: number;
  /** True for the first rejection in a lockout (audit once, not per retry). */
  firstRejection: boolean;
}

interface Entry {
  times: number[];
  rejecting: boolean;
}

export class ConnectThrottle {
  private entries = new Map<string, Entry>();

  constructor(
    private limit: number,
    private windowMs: number,
    private now: () => number = Date.now,
  ) {}

  check(key: string): ThrottleDecision {
    const now = this.now();
    this.sweep(now);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { times: [], rejecting: false };
      this.entries.set(key, entry);
    }
    entry.times = entry.times.filter((t) => now - t < this.windowMs);
    if (entry.times.length >= this.limit) {
      const firstRejection = !entry.rejecting;
      entry.rejecting = true;
      const retryAfterSec = Math.max(1, Math.ceil((entry.times[0] + this.windowMs - now) / 1000));
      return { allowed: false, retryAfterSec, firstRejection };
    }
    entry.rejecting = false;
    entry.times.push(now);
    return { allowed: true, retryAfterSec: 0, firstRejection: false };
  }

  size(): number {
    return this.entries.size;
  }

  private sweep(now: number): void {
    if (this.entries.size < 1000) return;
    for (const [key, entry] of this.entries) {
      if (entry.times.every((t) => now - t >= this.windowMs)) this.entries.delete(key);
    }
  }
}
