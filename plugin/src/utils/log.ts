import type { App } from "obsidian";
import { pluginDataPath } from "./pluginPaths";

type Level = "debug" | "info" | "warn" | "error";
type ErrSink = (ns: string, args: unknown[], row: LogRow) => void;

export interface LogRow {
  seq: number;
  ts: string;
  t: number;
  dt: number;
  sessionId: string;
  level: Level;
  ns: string;
  event: string;
  fields?: Record<string, unknown>;
}

interface DiagnosticsConfig {
  app?: App;
  uid?: string;
  debugLogging?: boolean;
  diagnosticLogging?: boolean;
  clientTelemetry?: {
    enabled: boolean;
    url: string;
  };
  context?: () => Record<string, unknown>;
}

const MAX_ROWS = 10000;
// Lines waiting for the next append; overflow is dropped and counted.
const MAX_TRACE_LINES = 20000;
// Per (level, ns, event) cap. A reconnect storm used to log ~5,000 rows/s and
// froze the renderer; suppressed rows are summarised as diag:rate-limited.
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_PER_WINDOW = 50;
// Trace files are append-only, rotate at MAX_TRACE_FILE_BYTES, and the oldest
// trace-*.jsonl files are removed once the folder passes MAX_TRACE_DIR_BYTES.
const TRACE_FLUSH_MS = 1000;
const MAX_TRACE_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TRACE_DIR_BYTES = 20 * 1024 * 1024;
const MAX_TELEMETRY_QUEUE = 50;
const MAX_STRING = 500;
const SECRET_KEY_RE = /(secret|password|token|key|code|auth|credential|content|body|text)/i;

let DEBUG = false;
let DIAGNOSTIC_FILE = false;
let appRef: App | null = null;
let uidHint = "";
let traceUntil = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushChain: Promise<void> = Promise.resolve();
let lastWritePath = "";
let tracePart = 0;
let traceFileBytes = 0;
let traceFileStarted = false;
let pruneDone = false;
let rateLimitedRows = 0;
const rateWindows = new Map<string, { start: number; count: number; suppressed: number }>();
const suppressedRows = new WeakSet<LogRow>();
let contextProvider: (() => Record<string, unknown>) | null = null;
let seq = 0;
let droppedRows = 0;
let droppedTraceLines = 0;
let telemetryEnabled = false;
let telemetryUrl = "";
let telemetryInFlight = false;
let telemetryDroppedRows = 0;
let telemetryFailures = 0;
let telemetryLastFailureAt = "";
let errSink: ErrSink | null = null;
let inErrSink = false;
const sessionStartedAt = Date.now();

const sessionId =
  (globalThis.crypto?.randomUUID?.() as string | undefined) ||
  `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const rows: LogRow[] = [];
const traceLines: string[] = [];
const telemetryQueue: LogRow[] = [];

export function configureDiagnostics(config: DiagnosticsConfig): void {
  if (config.app) appRef = config.app;
  if (config.uid !== undefined) uidHint = config.uid;
  if (config.debugLogging !== undefined) DEBUG = config.debugLogging;
  if (config.diagnosticLogging !== undefined) DIAGNOSTIC_FILE = config.diagnosticLogging;
  if (config.clientTelemetry !== undefined) {
    telemetryEnabled = !!config.clientTelemetry.enabled && !!config.clientTelemetry.url;
    telemetryUrl = config.clientTelemetry.url || "";
    if (!telemetryEnabled) telemetryQueue.length = 0;
  }
  if (config.context !== undefined) contextProvider = config.context;
}

export function setDebug(on: boolean): void {
  DEBUG = on;
}

export function setDiagnosticLogging(on: boolean): void {
  DIAGNOSTIC_FILE = on;
  record("info", "diag", on ? "file-enabled" : "file-disabled");
}

export function startDiagnosticTrace(ms = 2 * 60_000): string {
  traceUntil = Math.max(traceUntil, Date.now() + ms);
  record("info", "diag", "trace-started", { durationMs: ms, path: tracePath() });
  return tracePath();
}

export function stopDiagnosticTrace(): void {
  traceUntil = 0;
  record("info", "diag", "trace-stopped");
}

export async function exportDiagnosticBundle(): Promise<string> {
  const app = appRef;
  if (!app) throw new Error("diagnostics not configured");
  const path = `${diagnosticDir()}/diagnostic-bundle-${stamp()}.json`;
  record("info", "diag", "bundle-exported", { path, rows: rows.length });
  const body = JSON.stringify({
    exportedAt: new Date().toISOString(),
    sessionId,
    uid: uidHint ? redactUid(uidHint) : "",
    context: collectContext(),
    rows,
  }, null, 2);
  await app.vault.adapter.mkdir(diagnosticDir()).catch(() => {});
  await app.vault.adapter.write(path, body);
  return path;
}

export function getRecentDiagnostics(): LogRow[] {
  return rows.slice();
}

export function trace(ns: string, event: string, fields: Record<string, unknown> = {}): void {
  record("debug", ns, event, fields);
}

export function info(ns: string, event: string, fields: Record<string, unknown> = {}): void {
  record("info", ns, event, fields);
}

export function log(ns: string, ...args: unknown[]): void {
  record("debug", ns, "log", { args });
  if (DEBUG) console.log(`%c[collab:${ns}]`, "color:#54a0ff;font-weight:600", ...args);
}

export function warn(ns: string, ...args: unknown[]): void {
  record("warn", ns, "warn", { args });
  console.warn(`[collab:${ns}]`, ...args);
}

export function setErrSink(fn: ErrSink | null): void {
  errSink = fn;
}

export function err(ns: string, ...args: unknown[]): void {
  const row = record("error", ns, "error", { args });
  enqueueTelemetry(row);
  if (errSink && !inErrSink) {
    inErrSink = true;
    try {
      errSink(ns, args, row);
    } catch {
      // Error activity reporting must never become a recursive error source.
    } finally {
      inErrSink = false;
    }
  }
  console.error(`[collab:${ns}]`, ...args);
}

export function formatErrArgsForActivity(ns: string, args: unknown[], max = 220): string {
  const sanitizedArgs = sanitizeRecord({ args }).args;
  const values = Array.isArray(sanitizedArgs) ? sanitizedArgs : args;
  const text = values.map(formatActivityPart).filter(Boolean).join(" ");
  return trimActivityMessage(`${ns}: ${text || "plugin error"}`, max);
}

export function findErrPathArg(args: unknown[], ownsPath: (path: string) => boolean): string | null {
  for (const arg of args) {
    if (typeof arg === "string" && ownsPath(arg)) return arg;
  }
  return null;
}

function record(level: Level, ns: string, event: string, fields: Record<string, unknown> = {}): LogRow {
  const now = Date.now();
  if (rateLimited(`${level}:${ns}:${event}`, now)) {
    // Cheap placeholder for callers (err() hands it to sinks); not stored.
    const placeholder: LogRow = { seq, ts: "", t: now, dt: now - sessionStartedAt, sessionId, level, ns, event };
    suppressedRows.add(placeholder);
    return placeholder;
  }
  const row: LogRow = {
    seq: ++seq,
    ts: new Date().toISOString(),
    t: now,
    dt: now - sessionStartedAt,
    sessionId,
    level,
    ns,
    event,
    fields: sanitizeRecord(fields),
  };
  rows.push(row);
  while (rows.length > MAX_ROWS) {
    rows.shift();
    droppedRows++;
  }

  if (DIAGNOSTIC_FILE || now < traceUntil || level === "warn" || level === "error") {
    traceLines.push(JSON.stringify(row));
    while (traceLines.length > MAX_TRACE_LINES) {
      traceLines.shift();
      droppedTraceLines++;
    }
    scheduleFlush();
  }
  return row;
}

function rateLimited(key: string, now: number): boolean {
  let w = rateWindows.get(key);
  if (!w || now - w.start >= RATE_LIMIT_WINDOW_MS) {
    const suppressed = w?.suppressed ?? 0;
    w = { start: now, count: 0, suppressed: 0 };
    rateWindows.set(key, w);
    if (suppressed > 0) reportSuppressed(key, suppressed);
  }
  if (++w.count <= RATE_LIMIT_PER_WINDOW) return false;
  w.suppressed++;
  rateLimitedRows++;
  return true;
}

function reportSuppressed(key: string, suppressed: number): void {
  record("info", "diag", "rate-limited", { event: key, suppressed, windowMs: RATE_LIMIT_WINDOW_MS });
}

/** Summarise windows that ended with suppressed rows and never recurred. */
function sweepRateWindows(now: number): void {
  for (const [key, w] of rateWindows) {
    if (now - w.start < RATE_LIMIT_WINDOW_MS) continue;
    rateWindows.delete(key);
    if (w.suppressed > 0) reportSuppressed(key, w.suppressed);
  }
}

function enqueueTelemetry(row: LogRow): void {
  if (!telemetryEnabled || !telemetryUrl || row.level !== "error" || suppressedRows.has(row)) return;
  if (telemetryQueue.length >= MAX_TELEMETRY_QUEUE) {
    telemetryQueue.shift();
    telemetryDroppedRows++;
  }
  telemetryQueue.push(row);
  void flushTelemetryQueue();
}

async function flushTelemetryQueue(): Promise<void> {
  if (telemetryInFlight || !telemetryEnabled || !telemetryUrl) return;
  const row = telemetryQueue.shift();
  if (!row) return;

  telemetryInFlight = true;
  try {
    const res = await fetch(telemetryUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        row,
        context: collectContext(),
      }),
    });
    if (!res.ok) throw new Error(`clientlog ${res.status}`);
  } catch (e) {
    telemetryFailures++;
    telemetryLastFailureAt = new Date().toISOString();
    if (DEBUG) console.warn("[collab:diag] client telemetry failed", e);
  } finally {
    telemetryInFlight = false;
    if (telemetryQueue.length > 0) void flushTelemetryQueue();
  }
}

function scheduleFlush(): void {
  if (!appRef) return;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushChain = flushChain.then(flushTraceFile, flushTraceFile);
  }, TRACE_FLUSH_MS);
}

/** Append only the lines logged since the last flush (the old version
 *  rewrote the whole buffer, up to ~20 MB, every 600 ms). */
async function flushTraceFile(): Promise<void> {
  const app = appRef;
  sweepRateWindows(Date.now());
  if (!app || traceLines.length === 0) return;
  const chunk = traceLines.splice(0).join("\n") + "\n";
  const adapter = app.vault.adapter as any;
  try {
    await adapter.mkdir(diagnosticDir()).catch(() => {});
    if (!pruneDone) {
      pruneDone = true;
      await pruneTraceDir(MAX_TRACE_DIR_BYTES - MAX_TRACE_FILE_BYTES);
    }
    const path = tracePath();
    lastWritePath = path;
    if (!traceFileStarted || typeof adapter.append !== "function") {
      await adapter.write(path, chunk);
      traceFileStarted = true;
      traceFileBytes = chunk.length;
    } else {
      await adapter.append(path, chunk);
      traceFileBytes += chunk.length;
    }
    if (traceFileBytes >= MAX_TRACE_FILE_BYTES) {
      tracePart++;
      traceFileStarted = false;
      traceFileBytes = 0;
      lastWritePath = "";
      await pruneTraceDir(MAX_TRACE_DIR_BYTES - MAX_TRACE_FILE_BYTES);
    }
  } catch (e) {
    if (DEBUG) console.warn("[collab:diag] failed to write diagnostic trace", e);
  }
}

/** Delete the oldest trace-*.jsonl files until the folder fits the budget.
 *  Bundles and other files are never touched. */
async function pruneTraceDir(budgetBytes: number): Promise<void> {
  const adapter = appRef?.vault.adapter as any;
  if (!adapter || typeof adapter.list !== "function" || typeof adapter.stat !== "function") return;
  try {
    const listed = await adapter.list(diagnosticDir());
    const traces: { path: string; size: number; mtime: number }[] = [];
    for (const path of listed?.files ?? []) {
      if (!/\/trace-[^/]*\.jsonl$/.test(path)) continue;
      const st = await adapter.stat(path);
      if (st) traces.push({ path, size: st.size ?? 0, mtime: st.mtime ?? 0 });
    }
    let total = traces.reduce((n, t) => n + t.size, 0);
    traces.sort((a, b) => a.mtime - b.mtime);
    let removed = 0;
    for (const t of traces) {
      if (total <= budgetBytes) break;
      if (t.path === lastWritePath) continue;
      await adapter.remove(t.path);
      total -= t.size;
      removed++;
    }
    if (removed > 0) record("info", "diag", "trace-pruned", { removed, remainingBytes: total, budgetBytes });
  } catch (e) {
    if (DEBUG) console.warn("[collab:diag] failed to prune diagnostic traces", e);
  }
}

function sanitizeRecord(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = SECRET_KEY_RE.test(key) ? "[redacted]" : clean(value, key, 0);
  }
  return out;
}

function collectContext(): Record<string, unknown> {
  const base = {
    debugLogging: DEBUG,
    diagnosticLogging: DIAGNOSTIC_FILE,
    traceActive: Date.now() < traceUntil,
    traceUntil: traceUntil ? new Date(traceUntil).toISOString() : "",
    tracePath: tracePath(),
    rowCount: rows.length,
    traceLineCount: traceLines.length,
    maxRows: MAX_ROWS,
    maxTraceLines: MAX_TRACE_LINES,
    droppedRows,
    droppedTraceLines,
    rateLimitedRows,
    maxTraceFileBytes: MAX_TRACE_FILE_BYTES,
    maxTraceDirBytes: MAX_TRACE_DIR_BYTES,
    clientTelemetryEnabled: telemetryEnabled,
    clientTelemetryQueued: telemetryQueue.length,
    clientTelemetryDroppedRows: telemetryDroppedRows,
    clientTelemetryFailures: telemetryFailures,
    clientTelemetryLastFailureAt: telemetryLastFailureAt,
    nextSeq: seq + 1,
    sessionStartedAt: new Date(sessionStartedAt).toISOString(),
    sessionAgeMs: Date.now() - sessionStartedAt,
  };
  if (!contextProvider) return sanitizeRecord({ diagnostics: base });
  try {
    return sanitizeRecord({ ...contextProvider(), diagnostics: base });
  } catch (e) {
    return sanitizeRecord({ diagnostics: base, contextError: e });
  }
}

function clean(value: unknown, key: string, depth: number): unknown {
  if (SECRET_KEY_RE.test(key)) return "[redacted]";
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return cleanString(value, key);
  if (value instanceof Error) return { name: value.name, message: value.message, stack: trim(value.stack || "") };
  if (value instanceof Uint8Array) return { byteLength: value.byteLength };
  if (Array.isArray(value)) {
    if (depth > 2) return `[array:${value.length}]`;
    return value.slice(0, 20).map((v, i) => clean(v, `${key}.${i}`, depth + 1));
  }
  if (typeof value === "object") {
    if (depth > 2) return "[object]";
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      out[k] = clean(v, k, depth + 1);
    }
    return out;
  }
  return String(value);
}

function cleanString(value: string, key: string): string {
  if (SECRET_KEY_RE.test(key)) return "[redacted]";
  if (key.toLowerCase().includes("uid")) return redactUid(value);
  return trim(redactSecretFragments(value));
}

function trim(value: string): string {
  if (value.length <= MAX_STRING) return value;
  return `${value.slice(0, MAX_STRING)}…(${value.length} chars)`;
}

function redactUid(uid: string): string {
  if (uid.length <= 8) return uid;
  return `${uid.slice(0, 4)}…${uid.slice(-4)}`;
}

function formatActivityPart(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return redactSecretFragments(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return redactSecretFragments(JSON.stringify(value));
  } catch {
    return redactSecretFragments(String(value));
  }
}

function redactSecretFragments(value: string): string {
  return value
    .replace(/\b(bearer)\s+[-._~+/=A-Za-z0-9]+/gi, "$1 [redacted]")
    .replace(/\b(secret|password|token|key|code|auth|credential)=([^&\s]+)/gi, "$1=[redacted]")
    .replace(/\b(secret|password|token|key|code|auth|credential):\s*([^,\s}]+)/gi, "$1: [redacted]");
}

function trimActivityMessage(value: string, max: number): string {
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}...`;
}

function diagnosticDir(): string {
  return appRef ? pluginDataPath(appRef, "diagnostics") : ".obsidian/plugins/live-collab/diagnostics";
}

function tracePath(): string {
  if (lastWritePath) return lastWritePath;
  const part = tracePart > 0 ? `-${tracePart}` : "";
  return `${diagnosticDir()}/trace-${sessionId.slice(0, 8)}${part}.jsonl`;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}
