/**
 * Fault-injection harness for the 2026-09-25 alt-tab freeze: ~300 mux rooms on
 * one share, the sync server unreachable for 60 s, then back. Runs the REAL
 * createProvider / MuxProvider / FileProvider.reconnect / SyncManager.reconnect
 * / log.ts (from whichever tree `@src` points at, see run-reconnect-storm.mjs)
 * on a virtual clock, and measures what the renderer would have to do:
 * sockets opened, status/error events delivered to rooms, diagnostic rows and
 * bytes written, and real CPU time spent in plugin callbacks (main-thread busy
 * time, including the longest single task).
 *
 * Scenarios
 *   A. healthy server, Elijah alt-tabs 5 times (visibility-visible each time)
 *   B. server dies, alt-tab/wake events during a 60 s outage, server returns
 *
 * With STORM_ASSERT=1 it asserts the post-fix bounds; the "before" run only
 * reports numbers.
 */
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

// ── virtual clock (installed before any plugin code runs a timer) ──────────
const realSetImmediate = setImmediate;
let now = 1_800_000_000_000;
let nextTimerId = 1;
const timers = new Map();
globalThis.setTimeout = (fn, ms = 0, ...args) => {
  const id = nextTimerId++;
  timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn, args, every: 0 });
  return id;
};
globalThis.clearTimeout = (id) => { timers.delete(id); };
globalThis.setInterval = (fn, ms = 0, ...args) => {
  const id = nextTimerId++;
  const every = Math.max(1, Number(ms) || 1);
  timers.set(id, { at: now + every, fn, args, every });
  return id;
};
globalThis.clearInterval = (id) => { timers.delete(id); };
Date.now = () => now;

const busy = { ms: 0, longest: 0 };
function timed(fn) {
  const t0 = performance.now();
  try { fn(); } catch (e) { console.log("  task threw", e?.message ?? e); }
  const d = performance.now() - t0;
  busy.ms += d;
  if (d > busy.longest) busy.longest = d;
}
const drain = () => new Promise((r) => realSetImmediate(r));

async function advance(ms) {
  const target = now + ms;
  for (;;) {
    let next = null;
    let nextId = 0;
    for (const [id, t] of timers) {
      if (t.at <= target && (!next || t.at < next.at)) { next = t; nextId = id; }
    }
    if (!next) break;
    if (next.every) next.at += next.every;
    else timers.delete(nextId);
    now = Math.max(now, next.at - (next.every || 0));
    timed(() => next.fn(...next.args));
    await drain();
  }
  now = target;
  await drain();
}

// ── fake sync server + WebSocket ─────────────────────────────────────────
const MESSAGE_SYNC = 0;
const MESSAGE_MUX = 6;
const server = { up: true, docs: new Map(), open: new Set() };
const counters = { sockets: 0 };

function serverDoc(room) {
  let d = server.docs.get(room);
  if (!d) { d = new Y.Doc(); server.docs.set(room, d); }
  return d;
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.onopen = this.onclose = this.onerror = this.onmessage = null;
    counters.sockets++;
    setTimeout(() => {
      if (this.readyState !== FakeWebSocket.CONNECTING) return;
      if (!server.up) {
        this.readyState = FakeWebSocket.CLOSED;
        this.onerror?.({});
        this.onclose?.({ code: 1006 });
        return;
      }
      this.readyState = FakeWebSocket.OPEN;
      server.open.add(this);
      this.onopen?.({});
    }, 20);
  }
  send(data) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("socket is not open");
    if (!server.up) return;
    const outer = decoding.createDecoder(data);
    if (decoding.readVarUint(outer) !== MESSAGE_MUX) return;
    const room = decoding.readVarString(outer);
    const inner = decoding.createDecoder(decoding.readVarUint8Array(outer));
    this.joined ??= new Set();
    if (!this.joined.has(room)) {
      // Like server/src/rooms.ts joinRoom: the server opens with its own sync
      // step 1, which is what pulls the client's offline edits up.
      this.joined.add(room);
      const step1 = encoding.createEncoder();
      encoding.writeVarUint(step1, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(step1, serverDoc(room));
      this.deliver(room, encoding.toUint8Array(step1));
    }
    if (decoding.readVarUint(inner) !== MESSAGE_SYNC) return;
    const reply = encoding.createEncoder();
    encoding.writeVarUint(reply, MESSAGE_SYNC);
    syncProtocol.readSyncMessage(inner, reply, serverDoc(room), this);
    if (encoding.length(reply) <= 1) return;
    this.deliver(room, encoding.toUint8Array(reply));
  }
  deliver(room, payload) {
    const out = encoding.createEncoder();
    encoding.writeVarUint(out, MESSAGE_MUX);
    encoding.writeVarString(out, room);
    encoding.writeVarUint8Array(out, payload);
    const bytes = encoding.toUint8Array(out);
    setTimeout(() => {
      if (this.readyState === FakeWebSocket.OPEN) this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
    }, 5);
  }
  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    server.open.delete(this);
    setTimeout(() => this.onclose?.({ code: 1000 }), 1);
  }
}
globalThis.WebSocket = FakeWebSocket;

function killServer() {
  server.up = false;
  for (const ws of [...server.open]) {
    ws.readyState = FakeWebSocket.CLOSED;
    server.open.delete(ws);
    timed(() => ws.onclose?.({ code: 1006 }));
  }
}

// ── plugin code under test ──────────────────────────────────────────────
const { createProvider } = await import("@src/collab/YjsProvider.ts");
const { FileProvider } = await import("@src/collab/FileProvider.ts");
const { SyncManager } = await import("@src/collab/SyncManager.ts");
const log = await import("@src/utils/log.ts");

const diagFiles = new Map();
const diag = { bytesWritten: 0 };
const adapter = {
  async mkdir() {},
  async write(p, body) { diagFiles.set(p, body); diag.bytesWritten += body.length; },
  async append(p, body) { diagFiles.set(p, (diagFiles.get(p) ?? "") + body); diag.bytesWritten += body.length; },
  async list(dir) { return { files: [...diagFiles.keys()].filter((p) => p.startsWith(dir + "/")), folders: [] }; },
  async stat(p) { return diagFiles.has(p) ? { size: diagFiles.get(p).length, mtime: now, ctime: now, type: "file" } : null; },
  async remove(p) { diagFiles.delete(p); },
};
// Elijah's setup at the time of the freeze: debug + diagnostic logging on.
log.configureDiagnostics({ app: { vault: { configDir: ".obsidian", adapter } }, debugLogging: true, diagnosticLogging: true });
const origConsole = { log: console.log, error: console.error };
const out = (...a) => origConsole.log(...a);
let consoleErrors = 0;
console.error = () => { consoleErrors++; };
console.log = () => {};

const N = Number(process.env.STORM_ROOMS || 300);
const shareId = "stormshare";
const events = { status: 0, errors: 0, synced: 0 };
const user = { uid: "u1", name: "Elijah", color: "#ff0000" };
const auth = { __mux: "true", share: shareId };

function makeRoom(roomName, onSynced) {
  const doc = new Y.Doc();
  const provider = createProvider("wss://fake", roomName, doc, "tok", user, {
    onStatus: (status) => { events.status++; log.trace("ws", "file-status", { room: roomName, status }); },
    onError: (e) => { events.errors++; log.err("ws", "file provider connection error", { room: roomName }, e); },
    onSynced: (s) => { if (s) events.synced++; log.trace("ws", "file-synced", { room: roomName, synced: s }); onSynced?.(s); },
  }, { ...auth });
  return { doc, provider, roomName };
}

const manifest = makeRoom(`@${shareId}:__manifest__`);
const files = [];
for (let i = 1; i < N; i++) files.push(makeRoom(`@${shareId}:file:note-${i}.md`));
const fileProviders = new Map();
for (const f of files) {
  const fp = Object.create(FileProvider.prototype);
  Object.assign(fp, { provider: f.provider, filePath: f.roomName, roomName: f.roomName });
  fileProviders.set(f.roomName, fp);
}
const manager = Object.create(SyncManager.prototype);
Object.assign(manager, { manifestProvider: manifest.provider, fileProviders, share: { id: shareId } });
// main.ts reconnectAll(reason) → SyncManager.reconnect for every share.
const reconnectAll = (reason) => timed(() => manager.reconnect(reason));

const allRooms = [manifest, ...files];
const allConnected = () => allRooms.every((r) => r.provider.wsconnected);

function lastSeq() { return log.getRecentDiagnostics().at(-1)?.seq ?? 0; }
function snapshot() {
  return { t: now, busy: busy.ms, sockets: counters.sockets, status: events.status, errors: events.errors,
    seq: lastSeq(), bytes: diag.bytesWritten, consoleErrors };
}
function delta(a, b, extra = {}) {
  const secs = (b.t - a.t) / 1000;
  const ev = (b.status - a.status) + (b.errors - a.errors);
  return {
    simSeconds: +secs.toFixed(1),
    socketsOpened: b.sockets - a.sockets,
    roomEvents: ev,
    roomEventsPerSec: +(ev / secs).toFixed(1),
    diagRows: b.seq - a.seq,
    diagRowsPerSec: +((b.seq - a.seq) / secs).toFixed(1),
    diagMBWritten: +((b.bytes - a.bytes) / 1e6).toFixed(2),
    consoleErrors: b.consoleErrors - a.consoleErrors,
    busyMs: Math.round(b.busy - a.busy),
    ...extra,
  };
}

// ── setup: everything connected and synced ──────────────────────────────
await advance(3000);
const setupOk = allConnected();
busy.longest = 0;

// ── A: healthy server, 5 alt-tabs ───────────────────────────────────────
let s0 = snapshot();
for (let i = 0; i < 5; i++) {
  reconnectAll("visibility-visible");
  await advance(2000);
}
await advance(3000);
const A = delta(s0, snapshot(), { longestTaskMs: Math.round(busy.longest), allConnectedAfter: allConnected() });

// ── B: 60 s outage with wake/alt-tab events, then server returns ────────
busy.longest = 0;
s0 = snapshot();
killServer();
const offlineText = "edited while the server was down";
files[0].doc.getText("codemirror").insert(0, offlineText);
for (const at of [1000, 1200, 1400, 5000, 20000, 45000]) {
  const target = s0.t + at;
  await advance(target - now);
  reconnectAll(at === 1200 ? "online" : "visibility-visible");
}
await advance(s0.t + 60_000 - now);
const outageEnd = snapshot();
const outage = delta(s0, outageEnd, { longestTaskMs: Math.round(busy.longest) });
server.up = true;
let recoveredAt = null;
while (now - outageEnd.t < 120_000) {
  await advance(500);
  if (allConnected() && serverDoc(files[0].roomName).getText("codemirror").toString().includes(offlineText)) {
    recoveredAt = now;
    break;
  }
}
const recoverNoPokeMs = recoveredAt ? recoveredAt - outageEnd.t : null;
const B = {
  ...outage,
  recoveredWithoutUserMs: recoverNoPokeMs,
  offlineEditReachedServer: serverDoc(files[0].roomName).getText("codemirror").toString().includes(offlineText),
  allConnectedAfter: allConnected(),
};

// ── C: normal sync still works after recovery ───────────────────────────
files[1].doc.getText("codemirror").insert(0, "live edit");
manifest.doc.getMap("files").set("note-1.md", { v: 1 });
await advance(1000);
const C = {
  fileEditReachedServer: serverDoc(files[1].roomName).getText("codemirror").toString() === "live edit",
  manifestEditReachedServer: serverDoc(manifest.roomName).getMap("files").has("note-1.md"),
};

// ── D: second outage; server returns, then one alt-tab → immediate retry ─
await advance(10_000);
busy.longest = 0;
const d0 = snapshot();
killServer();
await advance(60_000);
server.up = true;
await advance(1000);
reconnectAll("visibility-visible");
let dRecovered = null;
const dPoke = now;
while (now - dPoke < 120_000) {
  await advance(100);
  if (allConnected()) { dRecovered = now - dPoke; break; }
}
const D = delta(d0, snapshot(), { longestTaskMs: Math.round(busy.longest), recoveredAfterAltTabMs: dRecovered });

// diagnostics footprint
await advance(2000);
let traceBytesOnDisk = 0;
for (const [p, body] of diagFiles) if (/\/trace-[^/]*\.jsonl$/.test(p)) traceBytesOnDisk += body.length;

console.log = origConsole.log;
console.error = origConsole.error;
const result = { rooms: N, setupOk, A_healthyAltTabs: A, B_outage60s: B, C_normalSync: C, D_outageThenAltTab: D, traceMBOnDisk: +(traceBytesOnDisk / 1e6).toFixed(2) };
out(`STORM_RESULT ${JSON.stringify(result)}`);

if (process.env.STORM_ASSERT === "1") {
  let failures = 0;
  const check = (name, cond, extra = "") => {
    if (cond) out(`  ✓ ${name}`);
    else { failures++; out(`  ✗ ${name} ${extra}`); }
  };
  out("\nreconnect storm\n");
  check("setup: all rooms connected", setupOk);
  check("A: healthy alt-tab opens no new sockets", A.socketsOpened === 0, JSON.stringify(A));
  check("A: healthy alt-tab emits no per-room status churn", A.roomEvents === 0, JSON.stringify(A));
  check("A: no main-thread task over 50 ms", A.longestTaskMs < 50, JSON.stringify(A));
  check("B: one retry loop, not one per room (<= 12 sockets in 60 s)", B.socketsOpened <= 12, JSON.stringify(B));
  check("B: room events bounded to one drop fan-out (<= 2 per room)", B.roomEvents <= 2 * N, JSON.stringify(B));
  check("B: one connection error per outage, not one per room", B.consoleErrors <= 2, JSON.stringify(B));
  check("B: no main-thread task over 50 ms", B.longestTaskMs < 50, JSON.stringify(B));
  check("B: recovers on its own after the server returns (<= 65 s)", recoverNoPokeMs !== null && recoverNoPokeMs <= 65_000, JSON.stringify(B));
  check("B: offline edit reaches the server after recovery", B.offlineEditReachedServer);
  check("C: live file edit syncs", C.fileEditReachedServer);
  check("C: manifest edit syncs", C.manifestEditReachedServer);
  check("D: alt-tab after the server returns reconnects within 1 s", D.recoveredAfterAltTabMs !== null && D.recoveredAfterAltTabMs <= 1000, JSON.stringify(D));
  check("diagnostics stay under 20 MB", traceBytesOnDisk <= 20 * 1024 * 1024);
  out("");
  if (failures > 0) { out(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
  out("ALL PASSED");
}
process.exit(0);
