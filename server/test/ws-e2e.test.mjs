import { spawn } from "child_process";
import { createHmac } from "crypto";
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, "..");
const distIndex = path.join(serverRoot, "dist", "index.js");
const SERVER_SECRET = "server-secret-for-e2e-tests";
const ADMIN_SECRET = "admin-secret-for-e2e-tests";
const SHARE_OWNER_SECRET = "owner-secret-for-e2e-tests";
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

function roleKey(shareId, role, epoch) {
  return hmac(SERVER_SECRET, `${shareId}:${role}:${epoch}`);
}

function adminToken(shareId, epoch) {
  return hmac(ADMIN_SECRET, `admin:${shareId}:${epoch}`);
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
    ADMIN_SECRET,
    SHARE_OWNER_SECRET,
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

function authParams(role, epoch, shareId) {
  return {
    token: roleKey(shareId, role, epoch),
    role,
    epoch,
    uid: `uid-${role}-${Math.random().toString(36).slice(2)}`,
    name: `${role} user`,
    device: "test",
    deviceId: `device-${Math.random().toString(36).slice(2)}`,
  };
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
} finally {
  await stopServer(server);
}

console.log("");
if (failures > 0) { console.error(`FAILED - ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
