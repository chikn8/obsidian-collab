import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "fs";
import { dirname, join } from "path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const MAX_STRING = 512;
const MAX_ARRAY = 50;
const MAX_OBJECT_KEYS = 80;
const SECRET_KEY_RE = /(authorization|auth|credential|password|secret|token|key|code|content|body)/i;
const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_LOG_ROTATE_COUNT = 3;

const startedAt = Date.now();
let seq = 0;
let drainLastWriteAt = 0;
let drainLastError = "";
let drainDroppedRows = 0;

interface LogDrainConfig {
  enabled: boolean;
  path: string;
  maxBytes: number;
  rotateCount: number;
}

let logDrain = initialLogDrainConfig();

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
  writeToLogDrain(line);
}

export function getLogDrainHealth(): Record<string, unknown> {
  const health: Record<string, unknown> = {
    enabled: logDrain.enabled,
    ok: !logDrain.enabled || !drainLastError,
    droppedRows: drainDroppedRows,
  };
  if (!logDrain.enabled) return health;
  health.path = logDrain.path;
  health.maxBytes = logDrain.maxBytes;
  health.rotateCount = logDrain.rotateCount;
  health.lastWriteAt = drainLastWriteAt || undefined;
  health.lastError = drainLastError || undefined;
  try {
    health.bytes = existsSync(logDrain.path) ? statSync(logDrain.path).size : 0;
  } catch (e: any) {
    health.ok = false;
    health.lastError = trim(String(e?.message || e));
  }
  return health;
}

export function readLogDrainTail(options: { limit?: number; level?: LogLevel; event?: string } = {}): Record<string, unknown>[] {
  if (!logDrain.enabled) return [];
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit || 100)));
  let raw = "";
  const paths: string[] = [];
  for (let i = logDrain.rotateCount; i >= 1; i--) paths.push(`${logDrain.path}.${i}`);
  paths.push(logDrain.path);
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      raw += readFileSync(p, "utf8");
      if (!raw.endsWith("\n")) raw += "\n";
    } catch (e: any) {
      drainLastError = trim(String(e?.message || e));
      return [];
    }
  }
  if (!raw) return [];
  const rows: Record<string, unknown>[] = [];
  const lines = raw.trim().split(/\n+/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0 && rows.length < limit; i--) {
    try {
      const row = JSON.parse(lines[i]) as Record<string, unknown>;
      if (options.level && row.level !== options.level) continue;
      if (options.event && row.event !== options.event) continue;
      rows.push(row);
    } catch {
      // Ignore truncated/corrupt tail rows; the drain is best-effort diagnostics.
    }
  }
  rows.reverse();
  return rows;
}

export function configureLogDrainForTest(config: Partial<LogDrainConfig> | null): void {
  logDrain = config
    ? {
      enabled: !!config.enabled,
      path: config.path || defaultLogPath(),
      maxBytes: positiveInt(config.maxBytes, DEFAULT_LOG_MAX_BYTES),
      rotateCount: nonNegativeInt(config.rotateCount, DEFAULT_LOG_ROTATE_COUNT),
    }
    : initialLogDrainConfig();
  drainLastWriteAt = 0;
  drainLastError = "";
  drainDroppedRows = 0;
}

function writeToLogDrain(line: string): void {
  if (!logDrain.enabled) return;
  try {
    mkdirSync(dirname(logDrain.path), { recursive: true });
    rotateIfNeeded(Buffer.byteLength(line) + 1);
    appendFileSync(logDrain.path, `${line}\n`, "utf8");
    drainLastWriteAt = Date.now();
    drainLastError = "";
  } catch (e: any) {
    drainDroppedRows++;
    drainLastError = trim(String(e?.message || e));
  }
}

function rotateIfNeeded(nextBytes: number): void {
  if (logDrain.maxBytes <= 0 || !existsSync(logDrain.path)) return;
  const currentBytes = statSync(logDrain.path).size;
  if (currentBytes + nextBytes <= logDrain.maxBytes) return;

  if (logDrain.rotateCount <= 0) {
    unlinkSync(logDrain.path);
    return;
  }

  for (let i = logDrain.rotateCount - 1; i >= 1; i--) {
    const from = `${logDrain.path}.${i}`;
    const to = `${logDrain.path}.${i + 1}`;
    if (existsSync(from)) renameSync(from, to);
  }
  renameSync(logDrain.path, `${logDrain.path}.1`);
}

function initialLogDrainConfig(): LogDrainConfig {
  const explicit = process.env.SERVER_LOG_DRAIN;
  const enabled =
    explicit === "true" ||
    (!!process.env.SERVER_LOG_PATH && explicit !== "false") ||
    (process.env.NODE_ENV === "production" && explicit !== "false");
  return {
    enabled,
    path: process.env.SERVER_LOG_PATH || defaultLogPath(),
    maxBytes: positiveInt(Number(process.env.SERVER_LOG_MAX_BYTES), DEFAULT_LOG_MAX_BYTES),
    rotateCount: nonNegativeInt(Number(process.env.SERVER_LOG_ROTATE_COUNT), DEFAULT_LOG_ROTATE_COUNT),
  };
}

function defaultLogPath(): string {
  return join(process.env.PERSIST_DIR || "./collab-data", "server.jsonl");
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}
