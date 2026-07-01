import http from "http";
import { randomBytes } from "crypto";
import { WebSocketServer } from "ws";
import { setupMuxConnection, setupWSConnection, getMetrics, saveAllDocs, closeRevokedConnections, closeInviteConnections } from "./rooms.js";
import { BLOB_MAX_BYTES, loadBlob, readBlobBody, safeBlobHash, safeBlobRelPath, storeBlob } from "./blobs.js";
import { BLOB_GC_GRACE_MS, startBlobGc, stopBlobGc, sweepOrphanBlobs } from "./blobGc.js";
import {
  timingSafeEqualStr,
  verifyShareAccessAny,
  verifyInviteAccessAny,
  adminToken,
  ownerKey,
  roleKey,
  inviteKey,
  verifyOwnerAccessAny,
  verifyIdentitySignature,
  isIdentityUid,
  ROLES,
  type Role,
} from "./auth.js";
import { startSnapshots, stopSnapshots, commitSnapshotsNow } from "./snapshots.js";
import { listVersions, getVersion, listShareFiles } from "./history.js";
import { bindInviteIdentity, getInvite, getMinEpoch, putInvite, revokeInvite, setMinEpoch } from "./shareState.js";
import { startBackups, stopBackups } from "./backups.js";
import { auditEvent } from "./audit.js";
import { getRuntimeHealth } from "./runtime.js";
import { CLIENT_LOG_MAX_BYTES, clientLogFields } from "./clientLog.js";
import { getLogDrainHealth, logEvent, readLogDrainTail } from "./logging.js";
import { incMetric } from "./metrics.js";
import { collectServerHealth } from "./health.js";
import { startHealthMonitor, stopHealthMonitor } from "./healthMonitor.js";

const HOST = process.env.HOST || "0.0.0.0";
const PORT = parseInt(process.env.PORT || "8080", 10);
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";
// Secret used to derive/validate per-share capability tokens (Tier 2).
// Falls back to AUTH_TOKEN if unset so a deploy without the new var still
// validates shares against a known secret rather than an empty one.
const SERVER_SECRET = process.env.SERVER_SECRET || AUTH_TOKEN;
const ADMIN_SECRET = process.env.ADMIN_SECRET || SERVER_SECRET;
const METRICS_TOKEN = process.env.METRICS_TOKEN || ADMIN_SECRET;
const SHARE_MINT_TOKEN = process.env.SHARE_MINT_TOKEN || ADMIN_SECRET;
const SHARE_OWNER_SECRET = process.env.SHARE_OWNER_SECRET || ADMIN_SECRET;
const SERVER_SECRET_PREVIOUS = process.env.SERVER_SECRET_PREVIOUS || "";
const ADMIN_SECRET_PREVIOUS =
  process.env.ADMIN_SECRET_PREVIOUS || (process.env.ADMIN_SECRET ? "" : SERVER_SECRET_PREVIOUS);
const SHARE_OWNER_SECRET_PREVIOUS =
  process.env.SHARE_OWNER_SECRET_PREVIOUS || (process.env.SHARE_OWNER_SECRET ? "" : ADMIN_SECRET_PREVIOUS);
const SHARE_MINT_TOKEN_PREVIOUS =
  process.env.SHARE_MINT_TOKEN_PREVIOUS || (process.env.SHARE_MINT_TOKEN ? "" : ADMIN_SECRET_PREVIOUS);
const AUTH_TOKEN_PREVIOUS = process.env.AUTH_TOKEN_PREVIOUS || "";
const REQUIRE_AUTH = process.env.REQUIRE_AUTH === "true" || process.env.NODE_ENV === "production";
const DISABLE_LEGACY_ROOMS = process.env.DISABLE_LEGACY_ROOMS === "true";
const MIN_SECRET_LENGTH = Number(process.env.MIN_SECRET_LENGTH || 16);

function secretList(primary: string, previous: string, includeEmptyPrimary = false): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of [primary, ...previous.split(",")].entries()) {
    const secret = raw.trim();
    if ((!secret && !(includeEmptyPrimary && i === 0)) || seen.has(secret)) continue;
    seen.add(secret);
    out.push(secret);
  }
  return out;
}

const SERVER_SECRETS = secretList(SERVER_SECRET, SERVER_SECRET_PREVIOUS, !REQUIRE_AUTH);
const ADMIN_SECRETS = secretList(ADMIN_SECRET, ADMIN_SECRET_PREVIOUS, !REQUIRE_AUTH);
const METRICS_TOKENS = secretList(METRICS_TOKEN, "");
const SHARE_MINT_TOKENS = secretList(SHARE_MINT_TOKEN, SHARE_MINT_TOKEN_PREVIOUS);
const SHARE_OWNER_SECRETS = secretList(SHARE_OWNER_SECRET, SHARE_OWNER_SECRET_PREVIOUS, !REQUIRE_AUTH);
const AUTH_TOKENS = secretList(AUTH_TOKEN, AUTH_TOKEN_PREVIOUS);

function strongSecret(secret: string): boolean {
  return secret.trim().length >= MIN_SECRET_LENGTH;
}

if (REQUIRE_AUTH) {
  const problems: string[] = [];
  if (!strongSecret(SERVER_SECRET)) problems.push(`SERVER_SECRET must be at least ${MIN_SECRET_LENGTH} chars`);
  if (!strongSecret(ADMIN_SECRET)) problems.push(`ADMIN_SECRET must be at least ${MIN_SECRET_LENGTH} chars`);
  if (!strongSecret(METRICS_TOKEN)) problems.push(`METRICS_TOKEN must be at least ${MIN_SECRET_LENGTH} chars`);
  if (!strongSecret(SHARE_MINT_TOKEN)) problems.push(`SHARE_MINT_TOKEN must be at least ${MIN_SECRET_LENGTH} chars`);
  if (!strongSecret(SHARE_OWNER_SECRET)) problems.push(`SHARE_OWNER_SECRET must be at least ${MIN_SECRET_LENGTH} chars`);
  if (!DISABLE_LEGACY_ROOMS && !strongSecret(AUTH_TOKEN)) {
    problems.push(`AUTH_TOKEN must be at least ${MIN_SECRET_LENGTH} chars, or set DISABLE_LEGACY_ROOMS=true`);
  }
  for (const [label, secrets] of [
    ["SERVER_SECRET_PREVIOUS", secretList("", SERVER_SECRET_PREVIOUS)],
    ["ADMIN_SECRET_PREVIOUS", secretList("", ADMIN_SECRET_PREVIOUS)],
    ["SHARE_OWNER_SECRET_PREVIOUS", secretList("", SHARE_OWNER_SECRET_PREVIOUS)],
    ["SHARE_MINT_TOKEN_PREVIOUS", secretList("", SHARE_MINT_TOKEN_PREVIOUS)],
    ["AUTH_TOKEN_PREVIOUS", secretList("", AUTH_TOKEN_PREVIOUS)],
  ] as const) {
    for (const secret of secrets) {
      if (!strongSecret(secret)) problems.push(`${label} entries must be at least ${MIN_SECRET_LENGTH} chars`);
    }
  }
  if (problems.length > 0) {
    console.error(`[auth] refusing to start in ${process.env.NODE_ENV || "production-required"} mode:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
}

function shareIdOf(room: string): string | null {
  return room.startsWith("@") ? room.slice(1).split(":")[0] || null : null;
}

function bearerOrQueryToken(req: http.IncomingMessage, url: URL): string {
  const auth = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(Array.isArray(auth) ? auth[0] || "" : auth);
  return (match?.[1]?.trim() || url.searchParams.get("token") || "").trim();
}

function metricsAuthorized(req: http.IncomingMessage, url: URL): boolean {
  if (!REQUIRE_AUTH && !METRICS_TOKEN) return true;
  const provided = bearerOrQueryToken(req, url);
  return tokenMatchesAny(provided, METRICS_TOKENS);
}

function adminAuthorized(req: http.IncomingMessage, url: URL): boolean {
  if (!REQUIRE_AUTH && !ADMIN_SECRET) return true;
  const provided = bearerOrQueryToken(req, url);
  return tokenMatchesAny(provided, ADMIN_SECRETS);
}

function mintAuthorized(req: http.IncomingMessage, url: URL): boolean {
  const provided = bearerOrQueryToken(req, url);
  return tokenMatchesAny(provided, SHARE_MINT_TOKENS);
}

function tokenMatchesAny(provided: string, expected: string[]): boolean {
  if (expected.length === 0) return true;
  return !!provided && expected.some((secret) => timingSafeEqualStr(provided, secret));
}

function adminHmacAuthorized(token: string, shareId: string, epoch: number): boolean {
  const secrets = ADMIN_SECRETS.length > 0 ? ADMIN_SECRETS : [""];
  return secrets.some((secret) => timingSafeEqualStr(token, adminToken(secret, shareId, epoch)));
}

function remoteAddress(req: http.IncomingMessage): string {
  return req.socket.remoteAddress || "";
}

async function readJsonBody(req: http.IncomingMessage, maxBytes = 8192): Promise<any> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk.toString("utf-8");
    if (raw.length > maxBytes) throw new Error("request body too large");
  }
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function isRole(value: string | null): value is Role {
  return !!value && (ROLES as string[]).includes(value);
}

function inviteExpiresAt(url: URL): number | undefined {
  const raw = url.searchParams.get("exp");
  return raw != null && raw !== "" ? Number(raw) : undefined;
}

function identityParams(url: URL): { identityUid?: string; identityPublicKey?: string; identitySignature?: string } {
  const uid = (url.searchParams.get("uid") || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 128);
  return {
    identityUid: isIdentityUid(uid) ? uid : undefined,
    identityPublicKey: url.searchParams.get("identityKey") || undefined,
    identitySignature: url.searchParams.get("identitySig") || undefined,
  };
}

async function verifyNamespacedAccess(args: {
  shareId: string;
  token: string;
  role?: Role;
  epoch?: number;
  inviteId?: string;
  expiresAt?: number;
  identityUid?: string;
  identityPublicKey?: string;
  identitySignature?: string;
}): Promise<Role | null> {
  const min = await getMinEpoch(args.shareId);
  if (args.inviteId) {
    const granted = verifyInviteAccessAny(
      SERVER_SECRETS,
      args.shareId,
      args.token,
      args.role,
      args.epoch,
      args.inviteId,
      args.expiresAt,
      min
    );
    if (!granted) return null;
    const invite = await getInvite(args.shareId, args.inviteId);
    if (!invite || invite.revokedAt) return null;
    if (invite.role !== args.role || invite.epoch !== args.epoch) return null;
    if ((invite.expiresAt || 0) !== (args.expiresAt || 0)) return null;
    if (invite.expiresAt && Date.now() > invite.expiresAt) return null;
    if (!args.identityUid || !args.identityPublicKey || !args.identitySignature) return null;
    if (!(await verifyIdentitySignature(args.identityPublicKey, args.identityUid, args.identitySignature))) return null;
    if (!(await bindInviteIdentity(args.shareId, args.inviteId, args.identityUid, args.identityPublicKey))) return null;
    return granted;
  }
  return verifyShareAccessAny(SERVER_SECRETS, args.shareId, args.token, args.role, args.epoch, min);
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function generateShareId(len = 16): string {
  const bytes = randomBytes(len);
  let out = "";
  for (const b of bytes) out += BASE58[b % BASE58.length];
  return out;
}

// ── HTTP: health + read-only version-history API + admin revoke ──────────────
const server = http.createServer(async (req, res) => {
  const json = (code: number, body: unknown) => {
    res.writeHead(code, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
    });
    res.end(JSON.stringify(body));
  };
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const p = url.pathname;

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
      });
      res.end();
      return;
    }

    if (p === "/") {
      return json(200, { status: "ok", service: "obsidian-collab-server", version: "0.2.0" });
    }

    if (p === "/live") {
      return json(200, { status: "ok", service: "obsidian-collab-server", version: "0.2.0" });
    }

    if (p === "/health") {
      const health = await collectServerHealth();
      return json(health.status === "ok" ? 200 : 503, health);
    }

    if (p === "/metrics") {
      if (!metricsAuthorized(req, url)) return json(401, { error: "unauthorized" });
      return json(200, { ...getMetrics(), runtime: getRuntimeHealth(), logDrain: getLogDrainHealth() });
    }

    if (p === "/admin/logs") {
      if (!adminAuthorized(req, url)) return json(401, { error: "unauthorized" });
      const limit = Number(url.searchParams.get("limit") || 100);
      const level = url.searchParams.get("level") as any;
      const event = url.searchParams.get("event") || undefined;
      return json(200, {
        ok: true,
        logDrain: getLogDrainHealth(),
        rows: readLogDrainTail({
          limit,
          level: level === "debug" || level === "info" || level === "warn" || level === "error" ? level : undefined,
          event,
        }),
      });
    }

    if (p === "/clientlog" && req.method === "POST") {
      const shareId = url.searchParams.get("share") || "";
      const token = bearerOrQueryToken(req, url);
      const role = (url.searchParams.get("role") as Role | null) || undefined;
      const epoch = url.searchParams.get("epoch") != null ? Number(url.searchParams.get("epoch")) : undefined;
      const inviteId = url.searchParams.get("invite") || undefined;
      const expiresAt = inviteExpiresAt(url);
      const identity = identityParams(url);
      if (!shareId) return json(400, { error: "bad request" });
      const granted =
        shareId === "legacy" && !DISABLE_LEGACY_ROOMS && tokenMatchesAny(token, AUTH_TOKENS)
          ? "editor"
          : await verifyNamespacedAccess({ shareId, token, role, epoch, inviteId, expiresAt, ...identity });
      if (!granted) return json(401, { error: "unauthorized" });
      let body: any;
      try {
        body = await readJsonBody(req, CLIENT_LOG_MAX_BYTES);
      } catch (e: any) {
        if (String(e?.message || e) === "request body too large") {
          return json(413, { error: "request body too large", maxBytes: CLIENT_LOG_MAX_BYTES });
        }
        throw e;
      }
      logEvent("error", "client.error", clientLogFields({
        shareId,
        role: granted,
        remote: remoteAddress(req),
        body,
      }));
      incMetric("client_errors");
      return json(200, { ok: true });
    }

    if (p === "/blob" && (req.method === "GET" || req.method === "PUT")) {
      const shareId = url.searchParams.get("share") || "";
      const hash = (url.searchParams.get("hash") || "").toLowerCase();
      const token = bearerOrQueryToken(req, url);
      const role = (url.searchParams.get("role") as Role | null) || undefined;
      const epoch = url.searchParams.get("epoch") != null ? Number(url.searchParams.get("epoch")) : undefined;
      const inviteId = url.searchParams.get("invite") || undefined;
      const expiresAt = inviteExpiresAt(url);
      const identity = identityParams(url);
      if (!shareId || !safeBlobHash(hash)) return json(400, { error: "bad request" });
      const granted =
        shareId === "legacy" && !DISABLE_LEGACY_ROOMS && tokenMatchesAny(token, AUTH_TOKENS)
          ? "editor"
          : await verifyNamespacedAccess({ shareId, token, role, epoch, inviteId, expiresAt, ...identity });
      if (!granted) return json(401, { error: "unauthorized" });

      if (req.method === "PUT") {
        const relPath = safeBlobRelPath(url.searchParams.get("path") || "");
        if (!relPath) {
          incMetric("rejected_paths");
          return json(400, { error: "bad path" });
        }
        if (granted !== "editor") {
          incMetric("rejected_writes");
          return json(403, { error: "forbidden" });
        }
        let body: Buffer;
        try {
          body = await readBlobBody(req);
        } catch (e: any) {
          if (String(e?.message || e) === "blob too large") {
            return json(413, { error: "blob too large", maxBytes: BLOB_MAX_BYTES });
          }
          throw e;
        }
        await storeBlob(shareId, hash, body);
        void auditEvent("blob.put", { shareId, relPath, hash, size: body.byteLength, role: granted, remote: remoteAddress(req) });
        return json(200, { ok: true, shareId, hash, size: body.byteLength });
      }

      const body = await loadBlob(shareId, hash);
      if (!body) return json(404, { error: "not found" });
      void auditEvent("blob.get", { shareId, hash, size: body.byteLength, role: granted, remote: remoteAddress(req) });
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(body.byteLength),
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "private, max-age=31536000, immutable",
      });
      res.end(body);
      return;
    }

    // Server-side share minting. Clients receive scoped per-share keys; the raw
    // SERVER_SECRET never needs to leave the server.
    if (p === "/share/create" && req.method === "POST") {
      if (!mintAuthorized(req, url)) return json(401, { error: "unauthorized" });
      const shareId = generateShareId();
      const epoch = 1;
      await setMinEpoch(shareId, epoch);
      void auditEvent("share.create", { shareId, role: "editor", epoch, remote: remoteAddress(req) });
      return json(200, {
        id: shareId,
        role: "editor",
        epoch,
        key: roleKey(SERVER_SECRET, shareId, "editor", epoch),
        ownerKey: ownerKey(SHARE_OWNER_SECRET, shareId, epoch),
      });
    }

    if (p === "/share/link" && req.method === "POST") {
      const shareId = url.searchParams.get("share") || "";
      const role = url.searchParams.get("role");
      const epoch = url.searchParams.get("epoch") != null ? Number(url.searchParams.get("epoch")) : undefined;
      const token = bearerOrQueryToken(req, url);
      if (!shareId || !isRole(role)) return json(400, { error: "bad request" });
      const min = await getMinEpoch(shareId);
      if (!verifyOwnerAccessAny(SHARE_OWNER_SECRETS, shareId, token, epoch, min)) {
        void auditEvent("share.link.rejected", { shareId, role, epoch, remote: remoteAddress(req), reason: "owner-auth" });
        return json(401, { error: "unauthorized" });
      }
      void auditEvent("share.link.minted", { shareId, role, epoch, remote: remoteAddress(req) });
      return json(200, {
        id: shareId,
        role,
        epoch,
        key: roleKey(SERVER_SECRET, shareId, role, epoch!),
      });
    }

    if (p === "/share/invite" && req.method === "POST") {
      const shareId = url.searchParams.get("share") || "";
      const role = url.searchParams.get("role");
      const epoch = url.searchParams.get("epoch") != null ? Number(url.searchParams.get("epoch")) : undefined;
      const token = bearerOrQueryToken(req, url);
      if (!shareId || !isRole(role) || epoch === undefined || !Number.isFinite(epoch)) return json(400, { error: "bad request" });
      const min = await getMinEpoch(shareId);
      if (!verifyOwnerAccessAny(SHARE_OWNER_SECRETS, shareId, token, epoch, min)) {
        void auditEvent("share.invite.rejected", { shareId, role, epoch, remote: remoteAddress(req), reason: "owner-auth" });
        return json(401, { error: "unauthorized" });
      }
      const body = await readJsonBody(req);
      const recipient = typeof body?.recipient === "string"
        ? body.recipient.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80)
        : "";
      const expiresAt = body?.expiresAt === undefined || body?.expiresAt === null || body?.expiresAt === ""
        ? undefined
        : Number(body.expiresAt);
      if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) {
        return json(400, { error: "bad expiry" });
      }
      const maxDevices = body?.maxDevices === undefined || body?.maxDevices === null || body?.maxDevices === ""
        ? 1
        : Number(body.maxDevices);
      if (!Number.isInteger(maxDevices) || maxDevices < 1 || maxDevices > 10) {
        return json(400, { error: "bad max devices" });
      }
      const inviteId = generateShareId(12);
      const createdAt = Date.now();
      await putInvite(shareId, {
        id: inviteId,
        role,
        epoch,
        createdAt,
        recipient: recipient || undefined,
        expiresAt,
        maxDevices,
      });
      void auditEvent("share.invite.created", { shareId, inviteId, role, epoch, recipient: recipient || undefined, expiresAt, maxDevices, remote: remoteAddress(req) });
      return json(200, {
        id: shareId,
        inviteId,
        role,
        epoch,
        recipient: recipient || undefined,
        expiresAt,
        maxDevices,
        createdAt,
        key: inviteKey(SERVER_SECRET, shareId, role, epoch, inviteId, expiresAt),
      });
    }

    if (p === "/share/invite/revoke" && req.method === "POST") {
      const shareId = url.searchParams.get("share") || "";
      const inviteId = url.searchParams.get("invite") || "";
      const epoch = url.searchParams.get("epoch") != null ? Number(url.searchParams.get("epoch")) : undefined;
      const token = bearerOrQueryToken(req, url);
      if (!shareId || !inviteId || epoch === undefined || !Number.isFinite(epoch)) return json(400, { error: "bad request" });
      const min = await getMinEpoch(shareId);
      if (!verifyOwnerAccessAny(SHARE_OWNER_SECRETS, shareId, token, epoch, min)) {
        void auditEvent("share.invite.revoke_rejected", { shareId, inviteId, epoch, remote: remoteAddress(req), reason: "owner-auth" });
        return json(401, { error: "unauthorized" });
      }
      const invite = await revokeInvite(shareId, inviteId);
      if (!invite) return json(404, { error: "not found" });
      const closedConnections = closeInviteConnections(shareId, inviteId);
      incMetric("revocations");
      void auditEvent("share.invite.revoked", { shareId, inviteId, role: invite.role, epoch: invite.epoch, closedConnections, remote: remoteAddress(req) });
      return json(200, { ok: true, shareId, inviteId, closedConnections, revokedAt: invite.revokedAt });
    }

    if (p === "/share/revoke" && req.method === "POST") {
      const shareId = url.searchParams.get("share") || "";
      const epoch = url.searchParams.get("epoch") != null ? Number(url.searchParams.get("epoch")) : undefined;
      const token = bearerOrQueryToken(req, url);
      if (!shareId || epoch === undefined || !Number.isFinite(epoch)) return json(400, { error: "bad request" });
      const min = await getMinEpoch(shareId);
      if (!verifyOwnerAccessAny(SHARE_OWNER_SECRETS, shareId, token, epoch, min)) {
        void auditEvent("share.revoke.rejected", { shareId, epoch, remote: remoteAddress(req), reason: "owner-auth" });
        return json(401, { error: "unauthorized" });
      }
      const newEpoch = Math.max(epoch + 1, min + 1);
      await setMinEpoch(shareId, newEpoch);
      const closedConnections = closeRevokedConnections(shareId, newEpoch);
      incMetric("revocations");
      void auditEvent("share.revoke", { shareId, oldEpoch: epoch, newEpoch, closedConnections, remote: remoteAddress(req) });
      return json(200, {
        ok: true,
        shareId,
        epoch: newEpoch,
        key: roleKey(SERVER_SECRET, shareId, "editor", newEpoch),
        ownerKey: ownerKey(SHARE_OWNER_SECRET, shareId, newEpoch),
        closedConnections,
      });
    }

    // History endpoints require a valid share token (any role — these are reads).
    if (p === "/history" || p === "/version" || p === "/files") {
      const shareId = url.searchParams.get("share") || "";
      const relPath = url.searchParams.get("path") || "";
      const token = url.searchParams.get("token") || "";
      const role = (url.searchParams.get("role") as Role | null) || undefined;
      const epoch = url.searchParams.get("epoch") != null ? Number(url.searchParams.get("epoch")) : undefined;
      const inviteId = url.searchParams.get("invite") || undefined;
      const expiresAt = inviteExpiresAt(url);
      const identity = identityParams(url);
      const granted =
        shareId === "legacy" && !DISABLE_LEGACY_ROOMS && tokenMatchesAny(token, AUTH_TOKENS)
          ? "editor"
          : shareId
            ? await verifyNamespacedAccess({ shareId, token, role, epoch, inviteId, expiresAt, ...identity })
            : null;
      if (!granted) return json(401, { error: "unauthorized" });

      if (p === "/history") return json(200, { versions: await listVersions(shareId, relPath) });
      if (p === "/files") return json(200, { files: await listShareFiles(shareId) });
      const hash = url.searchParams.get("hash") || "";
      const content = await getVersion(shareId, relPath, hash);
      return content == null ? json(404, { error: "not found" }) : json(200, { content });
    }

    // Admin: raise the revocation watermark (proves SERVER_SECRET knowledge).
    if (p === "/admin/revoke" && req.method === "POST") {
      const shareId = url.searchParams.get("share") || "";
      const epoch = Number(url.searchParams.get("epoch"));
      const token = bearerOrQueryToken(req, url);
      if (!shareId || !Number.isFinite(epoch)) return json(400, { error: "bad request" });
      if (!adminHmacAuthorized(token, shareId, epoch)) {
        void auditEvent("admin.revoke.rejected", { shareId, epoch, remote: remoteAddress(req), reason: "admin-auth" });
        return json(401, { error: "unauthorized" });
      }
      await setMinEpoch(shareId, epoch);
      const closedConnections = closeRevokedConnections(shareId, epoch);
      incMetric("revocations");
      void auditEvent("admin.revoke", { shareId, epoch, closedConnections, remote: remoteAddress(req) });
      return json(200, { ok: true, shareId, minEpoch: epoch, closedConnections });
    }

    if (p === "/admin/blob-gc" && req.method === "POST") {
      if (!adminAuthorized(req, url)) return json(401, { error: "unauthorized" });
      const dryRun = url.searchParams.get("dryRun") !== "false";
      const graceParam = url.searchParams.get("graceMs");
      const graceMs = graceParam == null ? BLOB_GC_GRACE_MS : Number(graceParam);
      if (!Number.isFinite(graceMs) || graceMs < 0) return json(400, { error: "bad graceMs" });
      const result = await sweepOrphanBlobs({ dryRun, graceMs });
      void auditEvent("admin.blob_gc", {
        dryRun,
        graceMs,
        scanned: result.scanned,
        deleted: result.deleted,
        bytesDeleted: result.bytesDeleted,
        remote: remoteAddress(req),
      });
      return json(200, { ok: true, ...result });
    }

    return json(404, { error: "not found" });
  } catch (e) {
    console.error("[http] error:", e);
    return json(500, { error: "internal" });
  }
});

// Create WebSocket server with manual upgrade handling for auth.
// maxPayload caps a single inbound frame (~2MB) so one client can't ship a giant
// update that bloats the volume/git history or OOMs the box.
const MAX_PAYLOAD = Number(process.env.WS_MAX_PAYLOAD || 2 * 1024 * 1024);
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

server.on("upgrade", async (request, socket, head) => {
  const url = new URL(request.url || "/", `http://${request.headers.host}`);
  const token = url.searchParams.get("token") || "";
  // y-websocket puts the room name in the (encoded) path: /<roomName>
  const room = decodeURIComponent(url.pathname.slice(1).split("?")[0]);
  const roleParam = (url.searchParams.get("role") as Role | null) || undefined;
  const epochParam = url.searchParams.get("epoch") != null ? Number(url.searchParams.get("epoch")) : undefined;
  const inviteParam = url.searchParams.get("invite") || undefined;
  const expParam = inviteExpiresAt(url);
  const identity = identityParams(url);

  // Authenticate. Namespaced share rooms ("@<shareId>:...") validate against a
  // per-share capability token (role+epoch folded into the HMAC, with a legacy
  // plain-key fallback = editor). Legacy un-prefixed rooms keep the AUTH_TOKEN gate.
  let grantedRole: Role = "editor";
  let ok: boolean;
  const shareId = shareIdOf(room);
  const muxRoom = !!shareId && room === `@${shareId}:__mux__`;
  if (shareId) {
    const role = await verifyNamespacedAccess({
      shareId,
      token,
      role: roleParam,
      epoch: epochParam,
      inviteId: inviteParam,
      expiresAt: expParam,
      ...identity,
    });
    ok = role !== null;
    if (role) grantedRole = role;
  } else {
    ok = !DISABLE_LEGACY_ROOMS && tokenMatchesAny(token, AUTH_TOKENS);
  }

  if (!ok) {
    const identityProvided = !!identity.identityUid && !!identity.identityPublicKey && !!identity.identitySignature;
    const reason = shareId && inviteParam && !identityProvided ? "identity-missing" : "token-or-identity";
    console.log(`[auth] rejected connection: ${reason} for room "${room}"`);
    void auditEvent("ws.auth.rejected", {
      room,
      shareId,
      role: roleParam,
      epoch: epochParam,
      inviteId: inviteParam,
      remote: request.socket.remoteAddress || "",
      uid: identity.identityUid,
      identityProvided,
      reason,
    });
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  // Carry the granted role to the connection setup (for write enforcement).
  (request as any).collabRole = grantedRole;
  (request as any).collabShareId = shareId;
  (request as any).collabEpoch = epochParam ?? 0;
  (request as any).collabInviteId = inviteParam ?? null;
  (request as any).collabMux = muxRoom;
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

// Handle new WebSocket connections
wss.on("connection", async (ws, req) => {
  try {
    if ((req as any).collabMux) await setupMuxConnection(ws, req);
    else await setupWSConnection(ws, req);
  } catch (e) {
    console.error("[server] connection setup error:", e);
    ws.close(4500, "Internal server error");
  }
});

// Start git snapshot system
startSnapshots().catch((e) => {
  console.error("[server] failed to start snapshots:", e);
});
startBackups();
startBlobGc();
startHealthMonitor();

// Start listening
server.listen(PORT, HOST, () => {
  console.log(`
  ┌─────────────────────────────────────────┐
  │   Obsidian Collab Server v0.1.0         │
  │                                         │
  │   WebSocket: ws://${HOST}:${PORT}${" ".repeat(Math.max(0, 17 - HOST.length - String(PORT).length))}│
  │   Health:    http://${HOST}:${PORT}${" ".repeat(Math.max(0, 16 - HOST.length - String(PORT).length))}│
  │                                         │
  │   Auth: ${SERVER_SECRET ? "enabled" : "DISABLED (set SERVER_SECRET)"}${" ".repeat(Math.max(0, SERVER_SECRET ? 20 : 0))}│
  └─────────────────────────────────────────┘
  `);
});

// Graceful shutdown. Railway sends SIGTERM during redeploy/stop, so flush active
// Yjs docs before the container exits instead of waiting for the next interval.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] shutting down (${signal})...`);

  const forceExit = setTimeout(() => {
    console.error("[server] forced shutdown after timeout");
    process.exit(1);
  }, 8000);
  forceExit.unref();

  stopSnapshots();
  stopBackups();
  stopBlobGc();
  stopHealthMonitor();
  await saveAllDocs(signal).catch((e) => console.error("[server] final save failed:", e));
  await commitSnapshotsNow().catch((e) => console.error("[server] final snapshot commit failed:", e));

  wss.clients.forEach((ws) => ws.close(1001, "Server shutting down"));
  server.close(() => {
    clearTimeout(forceExit);
    console.log("[server] goodbye");
    process.exit(0);
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
