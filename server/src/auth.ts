import { timingSafeEqual, createHmac } from "crypto";

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

/** Admin token proving server-secret knowledge for a control action (e.g. revoke). */
export function adminToken(secret: string, shareId: string, epoch: number): string {
  return hmac(secret, `admin:${shareId}:${epoch}`);
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
