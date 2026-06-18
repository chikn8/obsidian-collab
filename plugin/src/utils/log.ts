import type { App } from "obsidian";
import { pluginDataPath } from "./pluginPaths";

type Level = "debug" | "info" | "warn" | "error";

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
  context?: () => Record<string, unknown>;
}

const MAX_ROWS = 10000;
const MAX_TRACE_LINES = 50000;
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
let contextProvider: (() => Record<string, unknown>) | null = null;
let seq = 0;
let droppedRows = 0;
let droppedTraceLines = 0;
const sessionStartedAt = Date.now();

const sessionId =
  (globalThis.crypto?.randomUUID?.() as string | undefined) ||
  `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const rows: LogRow[] = [];
const traceLines: string[] = [];

export function configureDiagnostics(config: DiagnosticsConfig): void {
  if (config.app) appRef = config.app;
  if (config.uid !== undefined) uidHint = config.uid;
  if (config.debugLogging !== undefined) DEBUG = config.debugLogging;
  if (config.diagnosticLogging !== undefined) DIAGNOSTIC_FILE = config.diagnosticLogging;
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

export function err(ns: string, ...args: unknown[]): void {
  record("error", ns, "error", { args });
  console.error(`[collab:${ns}]`, ...args);
}

function record(level: Level, ns: string, event: string, fields: Record<string, unknown> = {}): void {
  const now = Date.now();
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
}

function scheduleFlush(): void {
  if (!appRef) return;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushChain = flushChain.then(flushTraceFile, flushTraceFile);
  }, 600);
}

async function flushTraceFile(): Promise<void> {
  const app = appRef;
  if (!app || traceLines.length === 0) return;
  const path = tracePath();
  lastWritePath = path;
  try {
    await app.vault.adapter.mkdir(diagnosticDir()).catch(() => {});
    await app.vault.adapter.write(path, traceLines.join("\n") + "\n");
  } catch (e) {
    if (DEBUG) console.warn("[collab:diag] failed to write diagnostic trace", e);
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
  return trim(value);
}

function trim(value: string): string {
  if (value.length <= MAX_STRING) return value;
  return `${value.slice(0, MAX_STRING)}…(${value.length} chars)`;
}

function redactUid(uid: string): string {
  if (uid.length <= 8) return uid;
  return `${uid.slice(0, 4)}…${uid.slice(-4)}`;
}

function diagnosticDir(): string {
  return appRef ? pluginDataPath(appRef, "diagnostics") : ".obsidian/plugins/live-collab/diagnostics";
}

function tracePath(): string {
  return lastWritePath || `${diagnosticDir()}/trace-${sessionId.slice(0, 8)}.jsonl`;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}
