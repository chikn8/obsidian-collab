import { createReadStream, createWriteStream } from "fs";
import fs from "fs/promises";
import path from "path";
import { pipeline } from "stream/promises";
import { createGzip } from "zlib";
import { logEvent } from "./logging.js";

const PERSIST_DIR = process.env.PERSIST_DIR || "./collab-data";
const AUDIT_LOG_PATH = process.env.AUDIT_LOG_PATH || path.join(PERSIST_DIR, "audit.jsonl");
const SECRET_KEY_RE = /(authorization|password|secret|token|key)$/i;
// Size rotation: audit.jsonl -> audit.jsonl.<UTC stamp> -> .gz. Rotated names
// match the backup script's *.jsonl.* exclusion. Only parts named
// "<basename>.<stamp>[.gz]" are ever pruned; manual archives are left alone.
// An unrotated audit log filled the 45 GB volume (2026-09-29).
const AUDIT_MAX_BYTES = positiveInt(process.env.AUDIT_LOG_MAX_BYTES, 64 * 1024 * 1024);
const AUDIT_ROTATE_COUNT = positiveInt(process.env.AUDIT_LOG_ROTATE_COUNT, 8);
const AUDIT_TOTAL_MAX_BYTES = positiveInt(process.env.AUDIT_LOG_TOTAL_MAX_BYTES, 512 * 1024 * 1024);
const ROTATED_PART_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(-\d+)?(\.gz)?$/;

let auditQueue: Promise<void> = Promise.resolve();
let compressQueue: Promise<void> = Promise.resolve();
// Estimated live file size; null until first stat. Re-stat before rotating so
// an external rename/truncate never triggers a spurious rotation.
let liveBytes: number | null = null;
let lastStamp = "";
let stampSeq = 0;

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

async function fileSize(p: string): Promise<number> {
  try {
    return (await fs.stat(p)).size;
  } catch (e: any) {
    if (e?.code === "ENOENT") return 0;
    throw e;
  }
}

function rotatedStamp(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (stamp === lastStamp) return `${stamp}-${++stampSeq}`;
  lastStamp = stamp;
  stampSeq = 0;
  return stamp;
}

async function rotateIfNeeded(nextBytes: number): Promise<void> {
  if (liveBytes === null) liveBytes = await fileSize(AUDIT_LOG_PATH);
  if (liveBytes + nextBytes <= AUDIT_MAX_BYTES) return;
  liveBytes = await fileSize(AUDIT_LOG_PATH);
  if (liveBytes === 0 || liveBytes + nextBytes <= AUDIT_MAX_BYTES) return;
  const rotated = `${AUDIT_LOG_PATH}.${rotatedStamp()}`;
  await fs.rename(AUDIT_LOG_PATH, rotated);
  liveBytes = 0;
  compressQueue = compressQueue.then(() => compressAndPrune(rotated)).catch((e) => {
    logEvent("error", "audit.rotate_failed", { auditPath: AUDIT_LOG_PATH, rotated, message: String((e as any)?.message || e) });
  });
}

async function compressAndPrune(rotated: string): Promise<void> {
  const tmp = `${rotated}.gz.tmp`;
  await pipeline(createReadStream(rotated), createGzip(), createWriteStream(tmp, { mode: 0o600 }));
  await fs.rename(tmp, `${rotated}.gz`);
  await fs.unlink(rotated);
  await pruneRotated();
}

async function pruneRotated(): Promise<void> {
  const dir = path.dirname(AUDIT_LOG_PATH);
  const prefix = `${path.basename(AUDIT_LOG_PATH)}.`;
  const names = (await fs.readdir(dir))
    .filter((n) => n.startsWith(prefix) && ROTATED_PART_RE.test(n.slice(prefix.length)))
    .sort();
  const parts: { name: string; bytes: number }[] = [];
  for (const name of names) parts.push({ name, bytes: await fileSize(path.join(dir, name)) });
  let total = parts.reduce((sum, p) => sum + p.bytes, 0);
  // Oldest first; always keep the newest part.
  while (parts.length > 1 && (parts.length > AUDIT_ROTATE_COUNT || total > AUDIT_TOTAL_MAX_BYTES)) {
    const oldest = parts.shift()!;
    await fs.unlink(path.join(dir, oldest.name));
    total -= oldest.bytes;
  }
}

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
  const bytes = Buffer.byteLength(line);
  const write = async () => {
    await fs.mkdir(path.dirname(AUDIT_LOG_PATH), { recursive: true });
    await rotateIfNeeded(bytes);
    await fs.appendFile(AUDIT_LOG_PATH, line, { encoding: "utf-8", mode: 0o600 });
    if (liveBytes !== null) liveBytes += bytes;
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
