import { timingSafeEqual, createHmac, webcrypto } from "crypto";

/**
 * Validate a provided token against the expected server token.
 * Uses timing-safe comparison to prevent timing attacks.
 * If no expected token is set, authentication is disabled.
 */
export function authenticate(provided: string, expected: string): boolean {
  // No auth configured — allow all connections
  if (!expected) return true;

  // Length mismatch — reject immediately (no timing info leaked)
  if (provided.length !== expected.length) return false;

  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Derive a share's capability token from the server secret and a share id.
 * The same derivation runs on the client when minting a share code, so the
 * server can validate statelessly (no per-share registry needed).
 *
 *   key = base64url( HMAC-SHA256(SERVER_SECRET, shareId) )
 */
export function hmac(secret: string, shareId: string): string {
  return createHmac("sha256", secret).update(shareId).digest("base64url");
}

/** Timing-safe string comparison (length-checked first to avoid throwing). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

export type Role = "viewer" | "commenter" | "editor";
export const ROLES: Role[] = ["viewer", "commenter", "editor"];

/**
 * Capability key for a role-scoped share:  HMAC(secret, "<shareId>:<role>:<epoch>").
 * Folding role+epoch into the HMAC makes roles unforgeable (joiners lack the
 * secret) and lets a creator revoke everyone by bumping the epoch.
 */
export function roleKey(secret: string, shareId: string, role: Role, epoch: number): string {
  return hmac(secret, `${shareId}:${role}:${epoch}`);
}

/** Per-recipient invite key. Adds invite id + expiry to the role-scoped HMAC. */
export function inviteKey(
  secret: string,
  shareId: string,
  role: Role,
  epoch: number,
  inviteId: string,
  expiresAt?: number
): string {
  return hmac(secret, `${shareId}:${role}:${epoch}:invite:${inviteId}:${expiresAt || 0}`);
}

/** Admin token proving server-secret knowledge for a control action (e.g. revoke). */
export function adminToken(secret: string, shareId: string, epoch: number): string {
  return hmac(secret, `admin:${shareId}:${epoch}`);
}

/** Per-share owner token. Lets a creator mint links/revoke only this share. */
export function ownerKey(secret: string, shareId: string, epoch: number): string {
  return hmac(secret, `owner:${shareId}:${epoch}`);
}

export function verifyOwnerAccess(
  secret: string,
  shareId: string,
  token: string,
  epoch: number | undefined,
  minEpoch: number
): boolean {
  if (epoch === undefined || !Number.isFinite(epoch)) return false;
  if (epoch < minEpoch) return false;
  return timingSafeEqualStr(token, ownerKey(secret, shareId, epoch));
}

/**
 * Validate a connection's access to a namespaced share. Back-compatible:
 *  - role/epoch absent  → legacy/plain key HMAC(secret, shareId), treated as editor.
 *  - role/epoch present → roleKey check, AND epoch must be >= the share's minEpoch.
 * Returns the granted role, or null if invalid.
 */
export function verifyShareAccess(
  secret: string,
  shareId: string,
  token: string,
  role: Role | undefined,
  epoch: number | undefined,
  minEpoch: number
): Role | null {
  if (role && epoch !== undefined && Number.isFinite(epoch)) {
    if (epoch < minEpoch) return null; // revoked
    if (!ROLES.includes(role)) return null;
    if (timingSafeEqualStr(token, roleKey(secret, shareId, role, epoch))) return role;
    return null;
  }
  // Plain capability key (existing shares) → full editor.
  if (timingSafeEqualStr(token, hmac(secret, shareId))) return "editor";
  return null;
}

export function verifyInviteAccess(
  secret: string,
  shareId: string,
  token: string,
  role: Role | undefined,
  epoch: number | undefined,
  inviteId: string | undefined,
  expiresAt: number | undefined,
  minEpoch: number,
  now = Date.now()
): Role | null {
  if (!role || epoch === undefined || !Number.isFinite(epoch)) return null;
  if (!inviteId || !/^[1-9A-HJ-NP-Za-km-z]{8,64}$/.test(inviteId)) return null;
  if (epoch < minEpoch) return null;
  if (!ROLES.includes(role)) return null;
  if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= now)) return null;
  return timingSafeEqualStr(token, inviteKey(secret, shareId, role, epoch, inviteId, expiresAt)) ? role : null;
}

const IDENTITY_B64URL_RE = /^[A-Za-z0-9_-]{16,4096}$/;
const IDENTITY_SIGNATURE_RE = /^[A-Za-z0-9_-]{80,256}$/;
const IDENTITY_UID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isIdentityUid(uid: string): boolean {
  return IDENTITY_UID_RE.test(uid);
}

export function identityPayload(uid: string, publicKey: string): Uint8Array {
  return new TextEncoder().encode(`obsidian-collab-identity-v1\n${uid}\n${publicKey}`);
}

export async function verifyIdentitySignature(
  publicKey: string,
  uid: string,
  signature: string
): Promise<boolean> {
  try {
    if (!isIdentityUid(uid)) return false;
    if (!IDENTITY_B64URL_RE.test(publicKey) || !IDENTITY_SIGNATURE_RE.test(signature)) return false;
    const jwk = JSON.parse(Buffer.from(publicKey, "base64url").toString("utf-8"));
    if (
      !jwk ||
      typeof jwk !== "object" ||
      jwk.kty !== "EC" ||
      jwk.crv !== "P-256" ||
      typeof jwk.x !== "string" ||
      typeof jwk.y !== "string" ||
      jwk.d !== undefined
    ) {
      return false;
    }
    const key = await webcrypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    return await webcrypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      Buffer.from(signature, "base64url"),
      identityPayload(uid, publicKey)
    );
  } catch {
    return false;
  }
}
