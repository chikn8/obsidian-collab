import fs from "fs/promises";
import path from "path";
import { logEvent } from "./logging.js";

const PERSIST_DIR = process.env.PERSIST_DIR || "./collab-data";
const AUDIT_LOG_PATH = process.env.AUDIT_LOG_PATH || path.join(PERSIST_DIR, "audit.jsonl");
const SECRET_KEY_RE = /(authorization|password|secret|token|key)$/i;

let auditQueue: Promise<void> = Promise.resolve();

function cleanValue(key: string, value: unknown): unknown {
  if (value === undefined) return undefined;
  if (SECRET_KEY_RE.test(key)) return "[redacted]";
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value === "string") return value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 512);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v, i) => cleanValue(String(i), v));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      const clean = cleanValue(childKey, childValue);
      if (clean !== undefined) out[childKey] = clean;
    }
    return out;
  }
  return String(value).slice(0, 512);
}

function cleanFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const clean = cleanValue(key, value);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

export function auditPathForTest(): string {
  return AUDIT_LOG_PATH;
}

export function auditEvent(event: string, fields: Record<string, unknown> = {}): Promise<void> {
  const row = {
    ts: new Date().toISOString(),
    event,
    ...cleanFields(fields),
  };
  const line = JSON.stringify(row) + "\n";
  const write = async () => {
    await fs.mkdir(path.dirname(AUDIT_LOG_PATH), { recursive: true });
    await fs.appendFile(AUDIT_LOG_PATH, line, { encoding: "utf-8", mode: 0o600 });
  };
  const next = auditQueue.then(write, write);
  auditQueue = next.catch(() => {});
  return next.catch((e) => {
    logEvent("error", "audit.write_failed", {
      auditPath: AUDIT_LOG_PATH,
      message: String((e as any)?.message || e),
    });
  });
}
