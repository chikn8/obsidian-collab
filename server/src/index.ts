import http from "http";
import { randomBytes } from "crypto";
import { WebSocketServer } from "ws";
import { setupWSConnection, getMetrics, saveAllDocs, closeRevokedConnections } from "./rooms.js";
import { authenticate, timingSafeEqualStr, verifyShareAccess, adminToken, ownerKey, roleKey, verifyOwnerAccess, ROLES, type Role } from "./auth.js";
import { startSnapshots, stopSnapshots, commitSnapshotsNow, getSnapshotsHealth } from "./snapshots.js";
import { listVersions, getVersion, listShareFiles } from "./history.js";
import { getMinEpoch, setMinEpoch, getShareStateHealth } from "./shareState.js";
import { getPersistenceHealth } from "./persistence.js";
import { startBackups, stopBackups, getBackupHealth } from "./backups.js";
import { auditEvent } from "./audit.js";

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
const REQUIRE_AUTH = process.env.REQUIRE_AUTH === "true" || process.env.NODE_ENV === "production";
const DISABLE_LEGACY_ROOMS = process.env.DISABLE_LEGACY_ROOMS === "true";
const MIN_SECRET_LENGTH = Number(process.env.MIN_SECRET_LENGTH || 16);

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
  return !!provided && !!METRICS_TOKEN && timingSafeEqualStr(provided, METRICS_TOKEN);
}

function mintAuthorized(req: http.IncomingMessage, url: URL): boolean {
  const provided = bearerOrQueryToken(req, url);
  return !!provided && !!SHARE_MINT_TOKEN && timingSafeEqualStr(provided, SHARE_MINT_TOKEN);
}

function remoteAddress(req: http.IncomingMessage): string {
  return req.socket.remoteAddress || "";
}

function isRole(value: string | null): value is Role {
  return !!value && (ROLES as string[]).includes(value);
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
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      });
      res.end();
      return;
    }

    if (p === "/") {
      return json(200, { status: "ok", service: "obsidian-collab-server", version: "0.2.0" });
    }

    if (p === "/health") {
      const [persistence, snapshots] = await Promise.all([
        getPersistenceHealth(),
        Promise.resolve(getSnapshotsHealth()),
      ]);
      const shareState = getShareStateHealth();
      const backups = getBackupHealth();
      const ok = persistence.ok && snapshots.ok && shareState.ok && backups.ok;
      return json(ok ? 200 : 503, {
        status: ok ? "ok" : "degraded",
        service: "obsidian-collab-server",
        version: "0.2.0",
        persistence,
        snapshots,
        shareState,
        backups,
      });
    }

    if (p === "/metrics") {
      if (!metricsAuthorized(req, url)) return json(401, { error: "unauthorized" });
      return json(200, getMetrics());
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
      if (!verifyOwnerAccess(SHARE_OWNER_SECRET, shareId, token, epoch, min)) {
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

    if (p === "/share/revoke" && req.method === "POST") {
      const shareId = url.searchParams.get("share") || "";
      const epoch = url.searchParams.get("epoch") != null ? Number(url.searchParams.get("epoch")) : undefined;
      const token = bearerOrQueryToken(req, url);
      if (!shareId || epoch === undefined || !Number.isFinite(epoch)) return json(400, { error: "bad request" });
      const min = await getMinEpoch(shareId);
      if (!verifyOwnerAccess(SHARE_OWNER_SECRET, shareId, token, epoch, min)) {
        void auditEvent("share.revoke.rejected", { shareId, epoch, remote: remoteAddress(req), reason: "owner-auth" });
        return json(401, { error: "unauthorized" });
      }
      const newEpoch = Math.max(epoch + 1, min + 1);
      await setMinEpoch(shareId, newEpoch);
      const closedConnections = closeRevokedConnections(shareId, newEpoch);
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
      const min = await getMinEpoch(shareId);
      const granted =
        shareId === "legacy" && !DISABLE_LEGACY_ROOMS && authenticate(token, AUTH_TOKEN)
          ? "editor"
          : shareId
            ? verifyShareAccess(SERVER_SECRET, shareId, token, role, epoch, min)
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
      if (!timingSafeEqualStr(token, adminToken(ADMIN_SECRET, shareId, epoch))) {
        void auditEvent("admin.revoke.rejected", { shareId, epoch, remote: remoteAddress(req), reason: "admin-auth" });
        return json(401, { error: "unauthorized" });
      }
      await setMinEpoch(shareId, epoch);
      const closedConnections = closeRevokedConnections(shareId, epoch);
      void auditEvent("admin.revoke", { shareId, epoch, closedConnections, remote: remoteAddress(req) });
      return json(200, { ok: true, shareId, minEpoch: epoch, closedConnections });
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

  // Authenticate. Namespaced share rooms ("@<shareId>:...") validate against a
  // per-share capability token (role+epoch folded into the HMAC, with a legacy
  // plain-key fallback = editor). Legacy un-prefixed rooms keep the AUTH_TOKEN gate.
  let grantedRole: Role = "editor";
  let ok: boolean;
  const shareId = shareIdOf(room);
  if (shareId) {
    const min = await getMinEpoch(shareId);
    const role = verifyShareAccess(SERVER_SECRET, shareId, token, roleParam, epochParam, min);
    ok = role !== null;
    if (role) grantedRole = role;
  } else {
    ok = !DISABLE_LEGACY_ROOMS && authenticate(token, AUTH_TOKEN);
  }

  if (!ok) {
    console.log(`[auth] rejected connection: invalid token for room "${room}"`);
    void auditEvent("ws.auth.rejected", {
      room,
      shareId,
      role: roleParam,
      epoch: epochParam,
      remote: request.socket.remoteAddress || "",
      reason: "token",
    });
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  // Carry the granted role to the connection setup (for write enforcement).
  (request as any).collabRole = grantedRole;
  (request as any).collabShareId = shareId;
  (request as any).collabEpoch = epochParam ?? 0;
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

// Handle new WebSocket connections
wss.on("connection", async (ws, req) => {
  try {
    await setupWSConnection(ws, req);
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
