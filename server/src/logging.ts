export type LogLevel = "debug" | "info" | "warn" | "error";

const MAX_STRING = 512;
const MAX_ARRAY = 50;
const MAX_OBJECT_KEYS = 80;
const SECRET_KEY_RE = /(authorization|auth|credential|password|secret|token|key|code|content|body)/i;

const startedAt = Date.now();
let seq = 0;

function trim(value: string): string {
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, "");
  if (clean.length <= MAX_STRING) return clean;
  return `${clean.slice(0, MAX_STRING)}...(${clean.length} chars)`;
}

function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  return lower === "text" || lower.endsWith("text") || SECRET_KEY_RE.test(lower);
}

function clean(key: string, value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === undefined) return undefined;
  if (isSecretKey(key)) return "[redacted]";
  if (value instanceof Error) {
    return { name: value.name, message: trim(value.message), stack: value.stack ? trim(value.stack) : "" };
  }
  if (value instanceof Uint8Array) {
    return { byteLength: value.byteLength };
  }
  if (value instanceof ArrayBuffer) {
    return { byteLength: value.byteLength };
  }
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return trim(value);
  if (Array.isArray(value)) {
    if (depth >= 3) return `[array:${value.length}]`;
    return value.slice(0, MAX_ARRAY).map((child, i) => clean(String(i), child, depth + 1, seen));
  }
  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    if (depth >= 3) return "[object]";
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS)) {
      const cleaned = clean(childKey, childValue, depth + 1, seen);
      if (cleaned !== undefined) out[childKey] = cleaned;
    }
    seen.delete(value);
    return out;
  }
  return value;
}

export function logEvent(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const now = Date.now();
  const row: Record<string, unknown> = {
    seq: ++seq,
    ts: new Date().toISOString(),
    t: now,
    dt: now - startedAt,
    source: "collab-server",
    pid: process.pid,
    level,
    event,
  };
  for (const [key, value] of Object.entries(fields)) {
    const cleaned = clean(key, value);
    if (cleaned !== undefined) row[key] = cleaned;
  }
  const line = JSON.stringify(row);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
