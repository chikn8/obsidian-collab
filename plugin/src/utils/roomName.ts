import type { Share, Role } from "../types";

/**
 * Convert a vault-relative file path to a valid WebSocket room name fragment.
 */
export function toRoomName(filePath: string): string {
  return encodeURIComponent(filePath.replace(/\\/g, "/"));
}

/**
 * Convert a room name back to a file path.
 */
export function fromRoomName(roomName: string): string {
  return decodeURIComponent(roomName);
}

/**
 * Room-name prefix for a share. The legacy share keeps the OLD un-prefixed
 * rooms (so existing data/collaborators are untouched); every other share is
 * namespaced under "@<id>:". The leading "@" lets the server unambiguously
 * tell namespaced rooms apart from legacy ones (which never start with "@").
 */
export function roomPrefix(share: Share): string {
  return share.legacy ? "" : `@${share.id}:`;
}

export function manifestRoom(share: Share): string {
  return roomPrefix(share) + "__manifest__";
}

export function fileRoom(share: Share, relPath: string): string {
  return roomPrefix(share) + "file:" + encodeURIComponent(relPath);
}

/** The WebSocket auth token to use for a share's rooms. */
export function shareToken(share: Share, serverPassword: string): string {
  return share.legacy ? serverPassword : share.key;
}

/** Extra WS query params carrying the role+epoch for a role-scoped share. */
export function shareAuthParams(share: Share): Record<string, string> {
  if (share.legacy || !share.role || share.epoch == null) return {};
  const params: Record<string, string> = { role: share.role, epoch: String(share.epoch) };
  if (share.inviteId) params.invite = share.inviteId;
  if (share.expiresAt) params.exp = String(share.expiresAt);
  return params;
}

/** ws(s):// -> http(s):// base for the HTTP history/admin API. */
export function httpBase(serverUrl: string): string {
  return serverUrl.replace(/^ws/, "http").replace(/\/$/, "");
}

// ── Share codes ────────────────────────────────────────────────────────────

export interface ShareCode {
  s: string; // serverUrl
  id: string;
  k: string; // key
  r?: Role; // role
  e?: number; // epoch
  i?: string; // invite id
  x?: number; // expiresAt ms epoch
  l?: string; // human label, optional/non-authoritative
}

/** Encode a share into a compact copy-paste code (optionally role-scoped). */
export function encodeShareCode(
  serverUrl: string,
  id: string,
  key: string,
  role?: Role,
  epoch?: number,
  inviteId?: string,
  expiresAt?: number,
  label?: string
): string {
  const obj: ShareCode = { s: serverUrl, id, k: key };
  if (role) obj.r = role;
  if (epoch != null) obj.e = epoch;
  if (inviteId) obj.i = inviteId;
  if (expiresAt != null) obj.x = expiresAt;
  if (label?.trim()) obj.l = label.trim().slice(0, 80);
  return base64urlFromBinary(utf8ToBinary(JSON.stringify(obj)));
}

/** Decode a share code; returns null if malformed. */
export function decodeShareCode(code: string): ShareCode | null {
  try {
    const obj = JSON.parse(binaryToUtf8(base64urlToBinary(code.trim())));
    if (obj && typeof obj.s === "string" && typeof obj.id === "string" && typeof obj.k === "string") {
      return obj as ShareCode;
    }
  } catch {
    /* fall through */
  }
  return null;
}

// ── Crypto helpers (WebCrypto — available in Obsidian desktop + mobile) ──────

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Generate an unguessable share id (~16 base58 chars ≈ 93 bits). */
export function generateShareId(len = 16): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += BASE58[b % BASE58.length];
  return out;
}

async function hmacB64url(secret: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(msg));
  let binary = "";
  for (const b of new Uint8Array(sig)) binary += String.fromCharCode(b);
  return base64urlFromBinary(binary);
}

/**
 * Plain (legacy/editor) share key. MUST match server auth.hmac():
 * base64url(HMAC-SHA256(secret, id)).
 */
export function deriveShareKey(serverSecret: string, shareId: string): Promise<string> {
  return hmacB64url(serverSecret, shareId);
}

/** Role-scoped key. MUST match server auth.roleKey(): HMAC(secret, "id:role:epoch"). */
export function deriveRoleKey(serverSecret: string, shareId: string, role: Role, epoch: number): Promise<string> {
  return hmacB64url(serverSecret, `${shareId}:${role}:${epoch}`);
}

/** Admin token for /admin/revoke. MUST match server auth.adminToken(). */
export function deriveAdminToken(serverSecret: string, shareId: string, epoch: number): Promise<string> {
  return hmacB64url(serverSecret, `admin:${shareId}:${epoch}`);
}

// base64url over a *binary* string (one char per byte, code points 0–255).
function base64urlFromBinary(binaryStr: string): string {
  return btoa(binaryStr).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToBinary(b64url: string): string {
  return atob(b64url.replace(/-/g, "+").replace(/_/g, "/"));
}

function utf8ToBinary(str: string): string {
  return unescape(encodeURIComponent(str));
}

function binaryToUtf8(binary: string): string {
  return decodeURIComponent(escape(binary));
}
