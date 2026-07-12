const ERROR_DEDUPE_MS = 5 * 60_000;
const ERROR_RATE_WINDOW_MS = 60 * 60_000;
const ERROR_RATE_LIMIT = 10;

export const ERROR_RATE_MUTED_MESSAGE = "error reporting muted for this share (rate limit)";

export type ErrorActivityAction = "post" | "muted" | "skip";

export class ErrorActivityGuard {
  private eventTimes: number[] = [];
  private dedupe: Map<string, number> = new Map();
  private rateMuted = false;

  next(message: string, path: string | undefined, now = Date.now()): ErrorActivityAction {
    this.prune(now);
    const dedupeKey = `${message}\n${path || ""}`;
    const lastAt = this.dedupe.get(dedupeKey) || 0;
    if (now - lastAt < ERROR_DEDUPE_MS) return "skip";

    if (this.eventTimes.length >= ERROR_RATE_LIMIT) {
      if (!this.rateMuted) {
        this.rateMuted = true;
        return "muted";
      }
      return "skip";
    }

    this.rateMuted = false;
    this.dedupe.set(dedupeKey, now);
    this.eventTimes.push(now);
    return "post";
  }

  private prune(now: number): void {
    this.eventTimes = this.eventTimes.filter((at) => now - at < ERROR_RATE_WINDOW_MS);
    for (const [key, at] of this.dedupe) {
      if (now - at >= ERROR_DEDUPE_MS) this.dedupe.delete(key);
    }
    if (this.eventTimes.length < ERROR_RATE_LIMIT) this.rateMuted = false;
  }
}
