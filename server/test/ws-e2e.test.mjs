import { spawn } from "child_process";
import { createHash, createHmac, webcrypto } from "crypto";
import fs from "fs/promises";
import net from "net";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import WebSocket from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

const MESSAGE_MUX = 6;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, "..");
const distIndex = path.join(serverRoot, "dist", "index.js");
const SERVER_SECRET = "server-secret-for-e2e-tests";
const SERVER_SECRET_PREVIOUS = "previous-server-secret-for-e2e-tests";
const ADMIN_SECRET = "admin-secret-for-e2e-tests";
const SHARE_OWNER_SECRET = "owner-secret-for-e2e-tests";
const SHARE_OWNER_SECRET_PREVIOUS = "previous-owner-secret-for-e2e-tests";
const SHARE_MINT_TOKEN = "mint-token-for-e2e-tests";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hmac(secret, msg) {
  return createHmac("sha256", secret).update(msg).digest("base64url");
}

function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

function roleKey(shareId, role, epoch, secret = SERVER_SECRET) {
  return hmac(secret, `${shareId}:${role}:${epoch}`);
}

function adminToken(shareId, epoch) {
  return hmac(ADMIN_SECRET, `admin:${shareId}:${epoch}`);
}

function ownerKey(shareId, epoch, secret = SHARE_OWNER_SECRET) {
  return hmac(secret, `owner:${shareId}:${epoch}`);
}

function identityPayload(uid, publicKey) {
  return new TextEncoder().encode(`obsidian-collab-identity-v1\n${uid}\n${publicKey}`);
}

async function makeIdentity(uid = `uid-${Math.random().toString(36).slice(2)}`) {
  const pair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const publicJwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  const publicKey = Buffer.from(JSON.stringify(publicJwk), "utf-8").toString("base64url");
  const signature = Buffer.from(await webcrypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    pair.privateKey,
    identityPayload(uid, publicKey)
  )).toString("base64url");
  return { uid, publicKey, signature };
}

function roomName(shareId, relPath) {
  return `@${shareId}:file:${encodeURIComponent(relPath)}`;
}

function statePath(persistDir, room) {
  return path.join(persistDir, `${encodeURIComponent(room)}.yjs`);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      lastError = String(e?.message || e);
    }
    await sleep(50);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError}` : ""}`);
}

async function waitForStateFile(persistDir, room) {
  await waitFor(async () => {
    await fs.stat(statePath(persistDir, room));
    return true;
  }, 5000, `state file for ${room}`);
}

async function startServer(persistDir) {
  await fs.stat(distIndex).catch(() => {
    throw new Error("Build the server first: cd server && npm run build");
  });

  const port = await freePort();
  const env = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    PERSIST_DIR: persistDir,
    SERVER_SECRET,
    SERVER_SECRET_PREVIOUS,
    ADMIN_SECRET,
    SHARE_OWNER_SECRET,
    SHARE_OWNER_SECRET_PREVIOUS,
    SHARE_MINT_TOKEN,
    AUTH_TOKEN: "",
    REQUIRE_AUTH: "true",
    DISABLE_LEGACY_ROOMS: "true",
    MIN_FREE_BYTES: "0",
    STALE_SAVE_MS: "60000",
    PERSIST_BACKUP_COMMAND: "",
    OPS_NTFY_TOPIC: "",
    NTFY_SERVER: "",
  };
  const child = spawn(process.execPath, [distIndex], {
    cwd: serverRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => { output += d.toString(); });
  child.stderr.on("data", (d) => { output += d.toString(); });
  child.on("exit", (code, signal) => {
    if (code && code !== 0) output += `\n[server exited ${code} ${signal || ""}]`;
  });

  const httpBase = `http://127.0.0.1:${port}`;
  const wsBase = `ws://127.0.0.1:${port}`;
  await waitFor(async () => {
    const res = await fetch(`${httpBase}/health`);
    return res.status === 200;
  }, 8000, `server health\n${output}`);
  return { child, port, httpBase, wsBase, output: () => output };
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null) return;
  server.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => server.child.once("exit", resolve)),
    sleep(9000).then(() => {
      if (server.child.exitCode === null) server.child.kill("SIGKILL");
    }),
  ]);
}

class SyncClient {
  constructor(wsBase, room, params) {
    this.doc = new Y.Doc();
    this.room = room;
    this.closeCode = null;
    this.closeReason = "";
    this.updatesSent = 0;
    const url = new URL(`${wsBase}/${encodeURIComponent(room)}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    this.ws = new WebSocket(url);
    this.doc.on("update", (update, origin) => {
      if (origin === this || this.ws.readyState !== WebSocket.OPEN) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      syncProtocol.writeUpdate(encoder, update);
      this.ws.send(encoding.toUint8Array(encoder));
      this.updatesSent++;
    });
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`connect timeout for ${room}`)), 5000);
      this.ws.on("open", () => {
        setTimeout(() => {
          clearTimeout(timer);
          if (this.ws.readyState === WebSocket.OPEN) this.sendSyncStep1();
          resolve();
        }, 25);
      });
      this.ws.on("error", reject);
    });
    this.closed = new Promise((resolve) => {
      this.ws.on("close", (code, reason) => {
        this.closeCode = code;
        this.closeReason = reason.toString();
        resolve({ code, reason: this.closeReason });
      });
    });
    this.ws.on("message", (data) => this.handleMessage(new Uint8Array(data)));
  }

  sendSyncStep1() {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    this.ws.send(encoding.toUint8Array(encoder));
  }

  handleMessage(message) {
    const decoder = decoding.createDecoder(message);
    const messageType = decoding.readVarUint(decoder);
    if (messageType !== 0) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
    if (encoding.length(encoder) > 1 && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(encoding.toUint8Array(encoder));
    }
  }

  text() {
    return this.doc.getText("codemirror").toString();
  }

  setText(text) {
    const ytext = this.doc.getText("codemirror");
    this.doc.transact(() => {
      if (ytext.length > 0) ytext.delete(0, ytext.length);
      if (text.length > 0) ytext.insert(0, text);
    }, "local-test");
  }

  async waitForText(text, timeoutMs = 5000) {
    await waitFor(() => this.text() === text, timeoutMs, `text ${JSON.stringify(text)} in ${this.room}`);
  }

  async close() {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    this.ws.close();
    await Promise.race([this.closed, sleep(1500)]);
    this.doc.destroy();
  }
}

class MuxClient {
  constructor(wsBase, shareId, rooms, params) {
    this.shareId = shareId;
    this.docs = new Map();
    this.closeCode = null;
    const url = new URL(`${wsBase}/${encodeURIComponent(`@${shareId}:__mux__`)}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    this.ws = new WebSocket(url);
    for (const room of rooms) {
      const doc = new Y.Doc();
      this.docs.set(room, doc);
      doc.on("update", (update, origin) => {
        if (origin === this || this.ws.readyState !== WebSocket.OPEN) return;
        const inner = encoding.createEncoder();
        encoding.writeVarUint(inner, 0);
        syncProtocol.writeUpdate(inner, update);
        this.sendInner(room, encoding.toUint8Array(inner));
      });
    }
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`mux connect timeout for ${shareId}`)), 5000);
      this.ws.on("open", () => {
        setTimeout(() => {
          clearTimeout(timer);
          for (const room of this.docs.keys()) this.sendSyncStep1(room);
          resolve();
        }, 25);
      });
      this.ws.on("error", reject);
    });
    this.closed = new Promise((resolve) => {
      this.ws.on("close", (code, reason) => {
        this.closeCode = code;
        resolve({ code, reason: reason.toString() });
      });
    });
    this.ws.on("message", (data) => this.handleMessage(new Uint8Array(data)));
  }

  sendInner(room, inner) {
    const outer = encoding.createEncoder();
    encoding.writeVarUint(outer, MESSAGE_MUX);
    encoding.writeVarString(outer, room);
    encoding.writeVarUint8Array(outer, inner);
    this.ws.send(encoding.toUint8Array(outer));
  }

  sendSyncStep1(room) {
    const inner = encoding.createEncoder();
    encoding.writeVarUint(inner, 0);
    syncProtocol.writeSyncStep1(inner, this.docs.get(room));
    this.sendInner(room, encoding.toUint8Array(inner));
  }

  handleMessage(message) {
    const outer = decoding.createDecoder(message);
    const outerType = decoding.readVarUint(outer);
    if (outerType !== MESSAGE_MUX) return;
    const room = decoding.readVarString(outer);
    const innerBytes = decoding.readVarUint8Array(outer);
    const doc = this.docs.get(room);
    if (!doc) return;
    const inner = decoding.createDecoder(innerBytes);
    const messageType = decoding.readVarUint(inner);
    if (messageType !== 0) return;
    const reply = encoding.createEncoder();
    encoding.writeVarUint(reply, 0);
    syncProtocol.readSyncMessage(inner, reply, doc, this);
    if (encoding.length(reply) > 1 && this.ws.readyState === WebSocket.OPEN) {
      this.sendInner(room, encoding.toUint8Array(reply));
    }
  }

  text(room) {
    return this.docs.get(room).getText("codemirror").toString();
  }

  setText(room, text) {
    const ytext = this.docs.get(room).getText("codemirror");
    this.docs.get(room).transact(() => {
      if (ytext.length > 0) ytext.delete(0, ytext.length);
      if (text.length > 0) ytext.insert(0, text);
    }, "local-test");
  }

  async waitForText(room, text, timeoutMs = 5000) {
    await waitFor(() => this.text(room) === text, timeoutMs, `text ${JSON.stringify(text)} in ${room}`);
  }

  async close() {
    if (this.ws.readyState !== WebSocket.CLOSED) this.ws.close();
    await Promise.race([this.closed, sleep(1500)]);
    for (const doc of this.docs.values()) doc.destroy();
  }
}

async function expectWsRejected(wsBase, room, params) {
  return new Promise((resolve) => {
    const url = new URL(`${wsBase}/${encodeURIComponent(room)}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const ws = new WebSocket(url);
    let settled = false;
    const done = (ok, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.terminate(); } catch {}
      resolve({ ok, reason });
    };
    const timer = setTimeout(() => done(false, "timeout"), 4000);
    ws.on("open", () => done(false, "opened"));
    ws.on("unexpected-response", (_req, res) => done(res.statusCode === 401, `status=${res.statusCode}`));
    ws.on("error", (e) => {
      const message = String(e?.message || e);
      done(message.includes("401"), message);
    });
    ws.on("close", (code) => done(code !== 1000, `close=${code}`));
  });
}

function authParams(role, epoch, shareId, secret = SERVER_SECRET) {
  return {
    token: roleKey(shareId, role, epoch, secret),
    role,
    epoch,
    uid: `uid-${role}-${Math.random().toString(36).slice(2)}`,
    name: `${role} user`,
    device: "test",
    deviceId: `device-${Math.random().toString(36).slice(2)}`,
  };
}

function inviteAuthParams(invite, identity) {
  return {
    token: invite.key,
    role: invite.role,
    epoch: invite.epoch,
    invite: invite.inviteId,
    ...(invite.expiresAt ? { exp: invite.expiresAt } : {}),
    uid: identity.uid,
    identityKey: identity.publicKey,
    identitySig: identity.signature,
    name: "invite user",
    device: "test",
    deviceId: `device-${Math.random().toString(36).slice(2)}`,
  };
}

function queryParams(params) {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) q.set(key, String(value));
  return q.toString();
}

console.log("real server WebSocket e2e\n");

const persistDir = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-collab-ws-e2e-"));
let server = null;
try {
  server = await startServer(persistDir);

  console.log("Two editors converge through the real relay");
  {
    const shareId = "e2e-editors";
    const room = roomName(shareId, "note.md");
    const A = new SyncClient(server.wsBase, room, authParams("editor", 1, shareId));
    const B = new SyncClient(server.wsBase, room, authParams("editor", 1, shareId));
    await Promise.all([A.ready, B.ready]);
    A.setText("hello from editor A");
    await B.waitForText("hello from editor A");
    check("B received A's edit", B.text() === "hello from editor A");
    await A.close();
    await B.close();
  }

  console.log("Previous rotation secrets remain valid during grace window");
  {
    const shareId = "e2e-rotation";
    const epoch = 1;
    const room = roomName(shareId, "rotated.md");
    const oldClient = new SyncClient(server.wsBase, room, authParams("editor", epoch, shareId, SERVER_SECRET_PREVIOUS));
    await oldClient.ready;
    oldClient.setText("old key still accepted");
    await oldClient.waitForText("old key still accepted");
    check("old server secret can still join", oldClient.text() === "old key still accepted");
    await oldClient.close();

    const linkRes = await fetch(`${server.httpBase}/share/link?share=${encodeURIComponent(shareId)}&role=viewer&epoch=${epoch}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerKey(shareId, epoch, SHARE_OWNER_SECRET_PREVIOUS)}` },
    });
    const link = await linkRes.json();
    check("old owner key can mint during rotation", linkRes.status === 200 && link?.key, JSON.stringify(link));
    check("rotation mints new links with current secret", link.key === roleKey(shareId, "viewer", epoch), JSON.stringify(link));
  }

  console.log("Client error telemetry uses share auth");
  {
    const shareId = "e2e-clientlog";
    const body = {
      row: {
        sessionId: "clientlog-session",
        seq: 1,
        ts: new Date().toISOString(),
        dt: 10,
        level: "error",
        ns: "e2e",
        event: "error",
        fields: {
          token: "should-not-export",
          noteText: "should-not-export",
          path: "Shared/note.md",
          args: ["simulated provider failure"],
        },
      },
      context: {
        settings: { serverToken: "should-not-export", shareCount: 1 },
      },
    };
    const res = await fetch(`${server.httpBase}/clientlog?${queryParams({
      ...authParams("editor", 1, shareId),
      share: shareId,
    })}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    check("clientlog POST succeeds", res.status === 200, `status=${res.status}`);
    await waitFor(
      () => server.output().includes('"event":"client.error"') && server.output().includes('"shareId":"e2e-clientlog"'),
      3000,
      "clientlog server output"
    );
    check("clientlog server output is redacted", !server.output().includes("should-not-export"));
    const metricsRes = await fetch(`${server.httpBase}/metrics`, {
      headers: { Authorization: `Bearer ${ADMIN_SECRET}` },
    });
    const metrics = await metricsRes.json();
    check("clientlog increments metrics counter", metrics.counters?.client_errors >= 1, JSON.stringify(metrics.counters));

    const rejected = await fetch(`${server.httpBase}/clientlog?${queryParams({
      ...authParams("editor", 1, shareId, "wrong-secret"),
      share: shareId,
    })}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    check("clientlog rejects bad auth", rejected.status === 401, `status=${rejected.status}`);
  }

  console.log("Multiplexed clients sync multiple rooms over one socket each");
  {
    const shareId = "e2e-mux";
    const roomA = roomName(shareId, "mux-a.md");
    const roomB = roomName(shareId, "mux-b.md");
    const A = new MuxClient(server.wsBase, shareId, [roomA, roomB], authParams("editor", 1, shareId));
    const B = new MuxClient(server.wsBase, shareId, [roomA, roomB], authParams("editor", 1, shareId));
    await Promise.all([A.ready, B.ready]);
    A.setText(roomA, "mux room A text");
    A.setText(roomB, "mux room B text");
    await B.waitForText(roomA, "mux room A text");
    await B.waitForText(roomB, "mux room B text");
    check("mux room A converged", B.text(roomA) === "mux room A text");
    check("mux room B converged", B.text(roomB) === "mux room B text");
    const metricsRes = await fetch(`${server.httpBase}/metrics`, {
      headers: { Authorization: `Bearer ${ADMIN_SECRET}` },
    });
    const metrics = await metricsRes.json();
    const aMetric = metrics.detail?.find((r) => r.room === roomA);
    const bMetric = metrics.detail?.find((r) => r.room === roomB);
    check("mux rooms share two physical connections", aMetric?.conns === 2 && bMetric?.conns === 2, JSON.stringify({ a: aMetric?.conns, b: bMetric?.conns }));
    check("server sees two mux sockets", metrics.muxConnections === 2, `muxConnections=${metrics.muxConnections}`);
    await A.close();
    await B.close();
  }

  console.log("Viewer writes are rejected server-side");
  {
    const shareId = "e2e-viewer";
    const room = roomName(shareId, "viewer.md");
    const editor = new SyncClient(server.wsBase, room, authParams("editor", 1, shareId));
    const mirror = new SyncClient(server.wsBase, room, authParams("editor", 1, shareId));
    await Promise.all([editor.ready, mirror.ready]);
    editor.setText("server-owned text");
    await mirror.waitForText("server-owned text");
    await editor.close();
    await mirror.close();
    await waitForStateFile(persistDir, room);

    const viewer = new SyncClient(server.wsBase, room, authParams("viewer", 1, shareId));
    await viewer.ready;
    await viewer.waitForText("server-owned text");
    viewer.setText("viewer tried to write");
    await sleep(500);
    await viewer.close();

    const reader = new SyncClient(server.wsBase, room, authParams("editor", 1, shareId));
    await reader.ready;
    await reader.waitForText("server-owned text");
    check("viewer write did not persist", reader.text() === "server-owned text");
    await reader.close();
  }

  console.log("Commenter can write comments but not text");
  {
    const shareId = "e2e-commenter";
    const room = roomName(shareId, "commenter.md");
    const editor = new SyncClient(server.wsBase, room, authParams("editor", 1, shareId));
    const commenter = new SyncClient(server.wsBase, room, authParams("commenter", 1, shareId));
    await Promise.all([editor.ready, commenter.ready]);
    editor.setText("comment target");
    await commenter.waitForText("comment target");

    const thread = new Y.Map();
    thread.set("quote", "comment target");
    thread.set("resolved", false);
    const replies = new Y.Array();
    const reply = new Y.Map();
    reply.set("id", "r1");
    reply.set("text", "commenter note");
    replies.push([reply]);
    thread.set("replies", replies);
    commenter.doc.getMap("comments").set("c1", thread);
    await waitFor(() => editor.doc.getMap("comments").has("c1"), 3000, "commenter comment relay");
    check("commenter comment reached editor", editor.doc.getMap("comments").has("c1"));

    commenter.setText("commenter tried text");
    await sleep(500);
    check("commenter text write did not reach editor", editor.text() === "comment target", editor.text());
    await commenter.close();
    await editor.close();
    await waitForStateFile(persistDir, room);

    const reader = new SyncClient(server.wsBase, room, authParams("editor", 1, shareId));
    await reader.ready;
    await reader.waitForText("comment target");
    await waitFor(() => reader.doc.getMap("comments").has("c1"), 3000, "persisted commenter comment");
    check("commenter comment persisted", reader.doc.getMap("comments").has("c1"));
    await reader.close();
  }

  console.log("Persisted room reloads after server restart");
  {
    const shareId = "e2e-restart";
    const room = roomName(shareId, "restart.md");
    const writer = new SyncClient(server.wsBase, room, authParams("editor", 1, shareId));
    const mirror = new SyncClient(server.wsBase, room, authParams("editor", 1, shareId));
    await Promise.all([writer.ready, mirror.ready]);
    writer.setText("persist me across restart");
    await mirror.waitForText("persist me across restart");
    await writer.close();
    await mirror.close();
    await waitForStateFile(persistDir, room);
    await stopServer(server);
    server = await startServer(persistDir);

    const reader = new SyncClient(server.wsBase, room, authParams("editor", 1, shareId));
    await reader.ready;
    await reader.waitForText("persist me across restart");
    check("reader loaded persisted text", reader.text() === "persist me across restart");
    await reader.close();
  }

  console.log("Revocation closes live old-epoch sockets");
  {
    const shareId = "e2e-revoke";
    const room = roomName(shareId, "revoked.md");
    const client = new SyncClient(server.wsBase, room, authParams("editor", 1, shareId));
    await client.ready;
    const token = adminToken(shareId, 2);
    const res = await fetch(`${server.httpBase}/admin/revoke?share=${encodeURIComponent(shareId)}&epoch=2`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    check("admin revoke HTTP succeeds", res.status === 200, `status=${res.status}`);
    const closed = await Promise.race([
      client.closed,
      sleep(5000).then(() => null),
    ]);
    check("old epoch socket closed with 4003", closed?.code === 4003, `code=${closed?.code}`);
    client.doc.destroy();
  }

  console.log("Blob API syncs content-addressed attachments");
  {
    const shareId = "e2e-blob";
    const epoch = 1;
    const body = Buffer.from("fake image bytes");
    const hash = sha256Hex(body);
    const editorPutParams = {
      ...authParams("editor", epoch, shareId),
      share: shareId,
      path: "assets/photo.png",
      hash,
    };
    const putRes = await fetch(`${server.httpBase}/blob?${queryParams(editorPutParams)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body,
    });
    check("editor blob upload succeeds", putRes.status === 200, `status=${putRes.status}`);

    const getRes = await fetch(`${server.httpBase}/blob?${queryParams({
      ...authParams("viewer", epoch, shareId),
      share: shareId,
      hash,
    })}`);
    const downloaded = Buffer.from(await getRes.arrayBuffer());
    check("viewer blob download succeeds", getRes.status === 200 && downloaded.equals(body), `status=${getRes.status}`);

    const viewerPutRes = await fetch(`${server.httpBase}/blob?${queryParams({
      ...authParams("viewer", epoch, shareId),
      share: shareId,
      path: "assets/photo.png",
      hash,
    })}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body,
    });
    check("viewer blob upload is rejected", viewerPutRes.status === 403, `status=${viewerPutRes.status}`);

    const badPathRes = await fetch(`${server.httpBase}/blob?${queryParams({
      ...authParams("editor", epoch, shareId),
      share: shareId,
      path: "scripts/run.js",
      hash,
    })}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body,
    });
    check("unsupported blob extension is rejected", badPathRes.status === 400, `status=${badPathRes.status}`);

    const metricsRes = await fetch(`${server.httpBase}/metrics`, {
      headers: { Authorization: `Bearer ${ADMIN_SECRET}` },
    });
    const metrics = await metricsRes.json();
    check(
      "blob rejections increment metrics counters",
      metrics.counters?.rejected_writes >= 1 && metrics.counters?.rejected_paths >= 1,
      JSON.stringify(metrics.counters)
    );
  }

  console.log("Per-recipient invite can be revoked independently");
  {
    const shareId = "e2e-invite";
    const room = roomName(shareId, "invite.md");
    const epoch = 1;
    const inviteRes = await fetch(`${server.httpBase}/share/invite?share=${encodeURIComponent(shareId)}&role=editor&epoch=${epoch}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerKey(shareId, epoch)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ recipient: "Mira", expiresAt: Date.now() + 60_000, maxDevices: 2 }),
    });
    const invite = await inviteRes.json();
    check("invite mint HTTP succeeds", inviteRes.status === 200 && !!invite.inviteId && invite.maxDevices === 2, `status=${inviteRes.status}`);
    const identity = await makeIdentity("invite-user-a");
    const invited = new SyncClient(server.wsBase, room, inviteAuthParams(invite, identity));
    await invited.ready;
    invited.setText("invite can edit until revoked");
    await sleep(300);
    const otherIdentity = await makeIdentity("invite-user-b");
    const secondInvited = new SyncClient(server.wsBase, room, inviteAuthParams(invite, otherIdentity));
    await secondInvited.ready;
    await secondInvited.waitForText("invite can edit until revoked");
    secondInvited.setText("second configured device can edit");
    await invited.waitForText("second configured device can edit");
    const thirdIdentity = await makeIdentity("invite-user-c");
    const rejected = await expectWsRejected(server.wsBase, room, inviteAuthParams(invite, thirdIdentity));
    check("same invite rejects identities over the configured device limit", rejected.ok, rejected.reason);
    const revokeRes = await fetch(`${server.httpBase}/share/invite/revoke?share=${encodeURIComponent(shareId)}&invite=${encodeURIComponent(invite.inviteId)}&epoch=${epoch}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerKey(shareId, epoch)}` },
    });
    check("invite revoke HTTP succeeds", revokeRes.status === 200, `status=${revokeRes.status}`);
    const closedFirst = await Promise.race([
      invited.closed,
      sleep(5000).then(() => null),
    ]);
    const closedSecond = await Promise.race([
      secondInvited.closed,
      sleep(5000).then(() => null),
    ]);
    check("revoked invite sockets closed with 4003", closedFirst?.code === 4003 && closedSecond?.code === 4003, `first=${closedFirst?.code} second=${closedSecond?.code}`);
    const metricsRes = await fetch(`${server.httpBase}/metrics`, {
      headers: { Authorization: `Bearer ${ADMIN_SECRET}` },
    });
    const metrics = await metricsRes.json();
    check("revocations increment metrics counter", metrics.counters?.revocations >= 2, JSON.stringify(metrics.counters));
    invited.doc.destroy();
    secondInvited.doc.destroy();
  }
} finally {
  await stopServer(server);
}

console.log("");
if (failures > 0) { console.error(`FAILED - ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
