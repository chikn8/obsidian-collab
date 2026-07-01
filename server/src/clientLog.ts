export const CLIENT_LOG_MAX_BYTES = Number(process.env.CLIENT_LOG_MAX_BYTES || 64 * 1024);

// ── Per-sender rate limit ─────────────────────────────────────────────────────
// /clientlog does synchronous log writes; without a cap any share member could
// flood it and rotate away the server's own diagnostics. Sliding one-minute
// window per share+sender key, in-memory (fits the single-process server).
const CLIENT_LOG_WINDOW_MS = 60_000;
const CLIENT_LOG_MAX_PER_WINDOW = Number(process.env.CLIENT_LOG_MAX_PER_MINUTE || 60);
const clientLogWindows = new Map<string, number[]>();

export function clientLogRateLimited(key: string, now = Date.now()): boolean {
  const cutoff = now - CLIENT_LOG_WINDOW_MS;
  const stamps = (clientLogWindows.get(key) || []).filter((ts) => ts > cutoff);
  if (stamps.length >= CLIENT_LOG_MAX_PER_WINDOW) {
    clientLogWindows.set(key, stamps);
    return true;
  }
  stamps.push(now);
  clientLogWindows.set(key, stamps);
  // Opportunistic sweep so abandoned senders don't accumulate forever.
  if (clientLogWindows.size > 512) {
    for (const [k, v] of clientLogWindows) {
      if (!v.some((ts) => ts > cutoff)) clientLogWindows.delete(k);
    }
  }
  return false;
}

export function resetClientLogRateLimiterForTest(): void {
  clientLogWindows.clear();
}

const MAX_STRING = 500;
const MAX_ARRAY = 20;
const MAX_OBJECT_KEYS = 40;
const SECRET_KEY_RE = /(authorization|auth|credential|password|secret|token|key|code|content|body|text)/i;

export function clientLogFields(args: {
  shareId: string;
  role: string;
  remote: string;
  body: any;
}): Record<string, unknown> {
  const row = cleanObject(args.body?.row);
  const context = cleanObject(args.body?.context);
  return {
    shareId: cleanString(args.shareId),
    role: cleanString(args.role),
    remote: cleanString(args.remote),
    client: {
      sessionId: cleanString(String(row.sessionId || "")),
      seq: finiteNumber(row.seq),
      ts: cleanString(String(row.ts || "")),
      dt: finiteNumber(row.dt),
      level: cleanString(String(row.level || "")),
      ns: cleanString(String(row.ns || "")),
      event: cleanString(String(row.event || "")),
    },
    clientFields: clean("fields", row.fields, 0),
    clientContext: context,
  };
}

function cleanObject(value: unknown): Record<string, any> {
  const cleaned = clean("root", value, 0);
  return cleaned && typeof cleaned === "object" && !Array.isArray(cleaned)
    ? cleaned as Record<string, any>
    : {};
}

function clean(key: string, value: unknown, depth: number): unknown {
  if (value === undefined) return undefined;
  if (SECRET_KEY_RE.test(key)) return "[redacted]";
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return cleanString(value);
  if (Array.isArray(value)) {
    if (depth > 2) return `[array:${value.length}]`;
    return value.slice(0, MAX_ARRAY).map((child, i) => clean(String(i), child, depth + 1));
  }
  if (typeof value === "object") {
    if (depth > 2) return "[object]";
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS)) {
      const cleaned = clean(childKey, childValue, depth + 1);
      if (cleaned !== undefined) out[childKey] = cleaned;
    }
    return out;
  }
  return cleanString(String(value));
}

function cleanString(value: string): string {
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, "");
  if (clean.length <= MAX_STRING) return clean;
  return `${clean.slice(0, MAX_STRING)}...(${clean.length} chars)`;
}

function finiteNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}
