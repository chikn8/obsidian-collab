import fs from "fs/promises";
import path from "path";
import { alertOps } from "./notify.js";
import { atomicWriteFile } from "./storage.js";
import type { Role } from "./auth.js";

/**
 * Per-share control state persisted on the Railway volume. Currently just the
 * revocation watermark `minEpoch`: a role-scoped token is rejected when its
 * epoch < minEpoch, so a creator revokes all outstanding codes by bumping the
 * epoch (and re-sharing). Small JSON, loaded once and cached in memory.
 */
const PERSIST_DIR = process.env.PERSIST_DIR || "./collab-data";
const STATE_FILE = path.join(PERSIST_DIR, "share-state.json");

export interface ShareInviteEntry {
  id: string;
  role: Role;
  epoch: number;
  createdAt: number;
  recipient?: string;
  expiresAt?: number;
  revokedAt?: number;
}

interface ShareEntry {
  minEpoch: number;
  invites?: Record<string, ShareInviteEntry>;
}
type State = Record<string, ShareEntry>;

let cache: State | null = null;
let loadError: string | null = null;
let lastSaveOk = true;
let lastSaveTs = 0;
let lastSaveError: string | null = null;

function parseState(raw: string): State {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("share state is not a JSON object");
  }
  for (const [shareId, entry] of Object.entries(parsed as Record<string, any>)) {
    if (!entry || typeof entry !== "object" || !Number.isFinite(entry.minEpoch) || entry.minEpoch < 0) {
      throw new Error(`invalid share state entry for ${shareId}`);
    }
    if (entry.invites !== undefined) {
      if (!entry.invites || typeof entry.invites !== "object" || Array.isArray(entry.invites)) {
        throw new Error(`invalid invites map for ${shareId}`);
      }
      for (const [inviteId, invite] of Object.entries(entry.invites as Record<string, any>)) {
        if (
          !invite ||
          typeof invite !== "object" ||
          invite.id !== inviteId ||
          !["viewer", "commenter", "editor"].includes(invite.role) ||
          !Number.isFinite(invite.epoch) ||
          !Number.isFinite(invite.createdAt) ||
          (invite.expiresAt !== undefined && !Number.isFinite(invite.expiresAt)) ||
          (invite.revokedAt !== undefined && !Number.isFinite(invite.revokedAt))
        ) {
          throw new Error(`invalid invite ${inviteId} for ${shareId}`);
        }
      }
    }
  }
  return parsed as State;
}

function shareEntry(s: State, shareId: string): ShareEntry {
  const cur = s[shareId] || { minEpoch: 0 };
  if (!cur.invites) cur.invites = {};
  s[shareId] = cur;
  return cur;
}

async function load(): Promise<State> {
  if (cache) return cache;
  try {
    cache = parseState(await fs.readFile(STATE_FILE, "utf-8"));
    loadError = null;
  } catch (e: any) {
    if (e.code !== "ENOENT") {
      loadError = String(e?.message || e);
      console.error("[shareState] failed to load share-state.json; failing closed:", e);
      await alertOps("share-state-load", "ObsidianSync share state load failed", loadError);
      throw e;
    }
    cache = {};
    loadError = null;
  }
  return cache!;
}

async function save(): Promise<void> {
  try {
    await fs.mkdir(PERSIST_DIR, { recursive: true });
    await atomicWriteFile(STATE_FILE, JSON.stringify(cache ?? {}, null, 2), "utf-8");
    lastSaveOk = true;
    lastSaveTs = Date.now();
    lastSaveError = null;
  } catch (e: any) {
    lastSaveOk = false;
    lastSaveError = String(e?.message || e);
    await alertOps("share-state-save", "ObsidianSync share state save failed", lastSaveError);
    throw e;
  }
}

export async function getMinEpoch(shareId: string): Promise<number> {
  try {
    const s = await load();
    return s[shareId]?.minEpoch ?? 0;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** Raise the revocation watermark; idempotent (never lowers it). */
export async function setMinEpoch(shareId: string, epoch: number): Promise<void> {
  const s = await load();
  const cur = s[shareId]?.minEpoch ?? 0;
  if (epoch > cur) {
    s[shareId] = { ...(s[shareId] || {}), minEpoch: epoch };
    await save();
    console.log(`[shareState] ${shareId} minEpoch -> ${epoch}`);
  }
}

export async function putInvite(shareId: string, invite: ShareInviteEntry): Promise<void> {
  const s = await load();
  const entry = shareEntry(s, shareId);
  entry.invites![invite.id] = invite;
  await save();
}

export async function getInvite(shareId: string, inviteId: string): Promise<ShareInviteEntry | null> {
  const s = await load();
  return s[shareId]?.invites?.[inviteId] ?? null;
}

export async function revokeInvite(shareId: string, inviteId: string, revokedAt = Date.now()): Promise<ShareInviteEntry | null> {
  const s = await load();
  const invite = s[shareId]?.invites?.[inviteId];
  if (!invite) return null;
  if (!invite.revokedAt) {
    invite.revokedAt = revokedAt;
    await save();
  }
  return invite;
}

export function getShareStateHealth() {
  return {
    ok: !loadError && lastSaveOk,
    loadError,
    lastSaveOk,
    lastSaveTs,
    lastSaveError,
  };
}
