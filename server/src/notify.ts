import fs from "fs/promises";
import path from "path";
import { atomicWriteFile } from "./storage.js";
import { envFlag, productionDefault } from "./env.js";

/**
 * Server-side @mention push fan-out via ntfy.sh (ports Scripts/notify.sh to fetch).
 *
 * Clients register their ntfy topic (uid -> topic) on connect; a mention sends a
 * MESSAGE_NOTIFY frame {fromUid, fromName, toUid, title, body}. The server looks
 * up the target's topic from a PERSIST_DIR registry (so OFFLINE targets are
 * still reachable) and POSTs the push. Per-sender rate limiting guards against a
 * compromised joiner spamming (awareness identity is forgeable).
 */
const PERSIST_DIR = process.env.PERSIST_DIR || "./collab-data";
const REG_FILE = path.join(PERSIST_DIR, "notify-registry.json");
const NTFY_SERVER = process.env.NTFY_SERVER || "https://ntfy.sh";
const OPS_NTFY_TOPIC = process.env.OPS_NTFY_TOPIC || "";
const REQUIRE_OPS_ALERTS = envFlag("REQUIRE_OPS_ALERTS", productionDefault());
const OPS_ALERT_DEDUP_MS = Number(process.env.OPS_ALERT_DEDUP_MS || 15 * 60_000);

type Registry = Record<string, string | string[]>; // uid -> topic(s), string kept for old files
let registry: Registry | null = null;
const opsAlerts = new Map<string, number>();

async function loadReg(): Promise<Registry> {
  if (registry) return registry;
  try {
    const parsed = JSON.parse(await fs.readFile(REG_FILE, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("notify registry is not a JSON object");
    }
    registry = parsed as Registry;
  } catch (e: any) {
    if (e.code !== "ENOENT") {
      console.error("[notify] failed to load registry; refusing to overwrite corrupt state:", e);
      await alertOps("notify-registry-load", "ObsidianSync notify registry load failed", String(e?.message || e));
      throw e;
    }
    registry = {};
  }
  return registry!;
}

// Registry is namespaced per share so a member of one share can't register a
// topic that intercepts another share's mentions (cross-share hijack). The
// shareId comes from the AUTHED connection, not the client frame.
function regKey(shareId: string | null, uid: string): string {
  return `${shareId || "legacy"}:${uid}`;
}

function legacyRegKey(shareId: string | null, uid: string): string {
  return `${shareId || "legacy"}${String.fromCharCode(0)}${uid}`;
}

export async function registerTopic(shareId: string | null, uid: string, topic: string): Promise<void> {
  if (!uid || !topic) return;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(topic)) return; // ntfy topic charset
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) return;  // uid sanity
  const key = regKey(shareId, uid);
  const r = await loadReg();
  const existing = Array.isArray(r[key]) ? r[key] : r[key] ? [r[key] as string] : [];
  if (existing.includes(topic)) return;
  r[key] = [...existing, topic].slice(-10);
  await atomicWriteFile(REG_FILE, JSON.stringify(r), "utf-8");
}

export async function topicsFor(shareId: string | null, uid: string): Promise<string[]> {
  const r = await loadReg();
  const value = r[regKey(shareId, uid)] ?? r[legacyRegKey(shareId, uid)];
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

// ── rate limiting (per sender) ──────────────────────────────────────────────
const buckets = new Map<string, { count: number; resetAt: number }>();
const RATE_MAX = 20; // per window
const RATE_WINDOW_MS = 60_000;

function allow(fromUid: string, nowMs: number): boolean {
  let b = buckets.get(fromUid);
  if (!b || nowMs >= b.resetAt) {
    b = { count: 0, resetAt: nowMs + RATE_WINDOW_MS };
    buckets.set(fromUid, b);
  }
  if (b.count >= RATE_MAX) return false;
  b.count++;
  return true;
}

function asciiTitle(s: string): string {
  // HTTP header values must be latin1-safe; strip anything fancy.
  return (s || "Mention").replace(/[^\x20-\x7E]/g, "").slice(0, 120) || "Mention";
}

export async function alertOps(key: string, title: string, body: string): Promise<void> {
  if (!OPS_NTFY_TOPIC) return;
  const now = Date.now();
  const prev = opsAlerts.get(key) || 0;
  if (now - prev < OPS_ALERT_DEDUP_MS) return;
  opsAlerts.set(key, now);

  try {
    await fetch(`${NTFY_SERVER}/${OPS_NTFY_TOPIC}`, {
      method: "POST",
      headers: {
        Title: asciiTitle(title),
        Priority: "5",
        Tags: "warning",
      },
      body: body.slice(0, 1000),
    });
  } catch (e) {
    console.error("[notify] ops alert failed:", e);
  }
}

export function getOpsAlertHealth() {
  return {
    ok: !REQUIRE_OPS_ALERTS || !!OPS_NTFY_TOPIC,
    configured: !!OPS_NTFY_TOPIC,
    required: REQUIRE_OPS_ALERTS,
    dedupMs: OPS_ALERT_DEDUP_MS,
  };
}

export interface NotifyPayload {
  fromUid: string;
  fromName: string;
  toUid: string;
  title: string;
  body: string;
  filePath?: string;
}

function safeNotifyPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 512);
  if (!clean || clean.startsWith("/") || clean.includes("\\") || clean.includes(":")) return null;
  const parts = clean.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  if (!/\.(md|canvas)$/i.test(parts.at(-1) || "")) return null;
  return parts.join("/");
}

function clickForPath(value: unknown): string | null {
  const safePath = safeNotifyPath(value);
  return safePath ? `obsidian://open?path=${encodeURIComponent(safePath)}` : null;
}

/**
 * Validate + rate-limit + deliver one mention push within a single share.
 * `shareId` is the SENDER's authed share (from the connection), so a mention can
 * only reach a target registered in the same share — no cross-share delivery.
 * The server never forwards arbitrary client-supplied URLs. It only derives an
 * Obsidian open link from a sanitized vault-relative Markdown/Canvas path.
 */
export async function handleNotify(shareId: string | null, p: NotifyPayload, nowMs: number): Promise<void> {
  try {
    if (!p || !p.toUid || !p.fromUid || p.toUid === p.fromUid) return;
    // Rate-limit per (share, sender) so a forged fromUid can't dodge the bucket
    // and one sender can't spam across shares.
    if (!allow(`${shareId || "legacy"} ${p.fromUid}`, nowMs)) {
      console.log(`[notify] rate-limited ${p.fromUid}`);
      return;
    }
    const topics = await topicsFor(shareId, p.toUid);
    if (topics.length === 0) return; // target never registered a topic in this share
    const click = clickForPath(p.filePath);
    await Promise.allSettled(
      topics.map((topic) => {
        const headers: Record<string, string> = {
          Title: asciiTitle(p.title),
          Priority: "4",
          Tags: "speech_balloon",
        };
        if (click) headers.Click = click;
        return fetch(`${NTFY_SERVER}/${topic}`, {
          method: "POST",
          headers,
          body: (p.body || "").slice(0, 1000),
        });
      })
    );
    console.log(`[notify] sent mention ${p.fromUid} -> ${p.toUid} (${topics.length} topic(s))`);
  } catch (e) {
    console.error("[notify] send failed:", e);
  }
}
