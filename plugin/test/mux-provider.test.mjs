import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { MuxProvider, reconnectDelayForAttempt } from "../src/collab/MuxProvider.ts";

const MESSAGE_SYNC = 0;
const MESSAGE_MUX = 6;
const MESSAGE_MUX_LEAVE = 7;
const stats = {
  received: 0,
  sent: 0,
  updates: 0,
};

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(10);
  }
  throw new Error(`${label} timed out`);
}

function arrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

class FakeMuxRoom {
  constructor(name, hub) {
    this.name = name;
    this.hub = hub;
    this.doc = new Y.Doc();
    this.clients = new Set();
    this.doc.on("update", (update, origin) => {
      stats.updates++;
      const inner = encoding.createEncoder();
      encoding.writeVarUint(inner, MESSAGE_SYNC);
      syncProtocol.writeUpdate(inner, update);
      const message = encoding.toUint8Array(inner);
      for (const client of this.clients) {
        if (client !== origin) this.hub.send(client, this.name, message);
      }
    });
  }
}

class FakeMuxHub {
  constructor() {
    this.clients = new Set();
    this.rooms = new Map();
  }

  room(roomName) {
    let room = this.rooms.get(roomName);
    if (!room) {
      room = new FakeMuxRoom(roomName, this);
      this.rooms.set(roomName, room);
    }
    return room;
  }

  add(client) {
    this.clients.add(client);
  }

  remove(client) {
    this.clients.delete(client);
    for (const room of this.rooms.values()) room.clients.delete(client);
  }

  receive(client, data) {
    stats.received++;
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
    const outer = decoding.createDecoder(bytes);
    const outerType = decoding.readVarUint(outer);
    if (outerType === MESSAGE_MUX_LEAVE) {
      const roomName = decoding.readVarString(outer);
      this.room(roomName).clients.delete(client);
      return;
    }
    if (outerType !== MESSAGE_MUX) return;
    const roomName = decoding.readVarString(outer);
    const innerBytes = decoding.readVarUint8Array(outer);
    const room = this.room(roomName);
    room.clients.add(client);

    const inner = decoding.createDecoder(innerBytes);
    const messageType = decoding.readVarUint(inner);
    if (messageType !== MESSAGE_SYNC) return;

    const reply = encoding.createEncoder();
    encoding.writeVarUint(reply, MESSAGE_SYNC);
    syncProtocol.readSyncMessage(inner, reply, room.doc, client);
    if (encoding.length(reply) > 1) this.send(client, roomName, encoding.toUint8Array(reply));
  }

  send(client, roomName, inner) {
    if (client.readyState !== FakeWebSocket.OPEN) return;
    stats.sent++;
    const outer = encoding.createEncoder();
    encoding.writeVarUint(outer, MESSAGE_MUX);
    encoding.writeVarString(outer, roomName);
    encoding.writeVarUint8Array(outer, inner);
    const bytes = encoding.toUint8Array(outer);
    setTimeout(() => client.onmessage?.({ data: arrayBuffer(bytes) }), 0);
  }
}

const hubs = new Map();
function hubFor(rawUrl) {
  const url = new URL(rawUrl);
  const key = `${url.origin}${url.pathname}`;
  let hub = hubs.get(key);
  if (!hub) {
    hub = new FakeMuxHub();
    hubs.set(key, hub);
  }
  return hub;
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static created = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.binaryType = "arraybuffer";
    this.onopen = null;
    this.onclose = null;
    this.onerror = null;
    this.onmessage = null;
    this.hub = hubFor(url);
    FakeWebSocket.created.push(this);
    setTimeout(() => {
      if (this.readyState !== FakeWebSocket.CONNECTING) return;
      this.readyState = FakeWebSocket.OPEN;
      this.hub.add(this);
      this.onopen?.({});
    }, 0);
  }

  send(data) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("socket is not open");
    this.hub.receive(this, data);
  }

  close(code = 1000, reason = "") {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.hub.remove(this);
    setTimeout(() => this.onclose?.({ code, reason }), 0);
  }
}

globalThis.WebSocket = FakeWebSocket;

function setText(doc, value) {
  const text = doc.getText("codemirror");
  doc.transact(() => {
    if (text.length > 0) text.delete(0, text.length);
    if (value) text.insert(0, value);
  }, "test");
}

console.log("mux provider\n");

check("reconnect delay jitters first retry within bounds",
  reconnectDelayForAttempt(0, () => 0) === 300 && reconnectDelayForAttempt(0, () => 1) === 700);
check("reconnect delay caps high attempts",
  reconnectDelayForAttempt(20, () => 1) === 10000 && reconnectDelayForAttempt(20, () => 0) === 6000);

const shareId = "mux-test";
const roomA = `@${shareId}:file:a.md`;
const roomB = `@${shareId}:file:b.md`;
const serverUrl = "ws://fake";
const paramsA = { token: "t", uid: "a", name: "A", color: "#ff0000" };
const paramsB = { token: "t", uid: "b", name: "B", color: "#00ff00" };

const a1 = new Y.Doc();
const a2 = new Y.Doc();
const b1 = new Y.Doc();
const b2 = new Y.Doc();
const providers = [
  new MuxProvider({ serverUrl, shareId, roomName: roomA, ydoc: a1, params: paramsA }),
  new MuxProvider({ serverUrl, shareId, roomName: roomB, ydoc: a2, params: paramsA }),
  new MuxProvider({ serverUrl, shareId, roomName: roomA, ydoc: b1, params: paramsB }),
  new MuxProvider({ serverUrl, shareId, roomName: roomB, ydoc: b2, params: paramsB }),
];

try {
  await waitFor(
    () => FakeWebSocket.created.length === 2 && FakeWebSocket.created.every((ws) => ws.readyState === FakeWebSocket.OPEN),
    1000,
    "shared mux sockets"
  );
  check("one physical socket per user", FakeWebSocket.created.length === 2, `created=${FakeWebSocket.created.length}`);
  check("all providers report connected", providers.every((p) => p.wsconnected === true));

  setText(a1, "room A text");
  setText(a2, "room B text");
  await waitFor(
    () => b1.getText("codemirror").toString() === "room A text" &&
      b2.getText("codemirror").toString() === "room B text",
    1000,
    `remote mux text ${JSON.stringify({
      b1: b1.getText("codemirror").toString(),
      b2: b2.getText("codemirror").toString(),
      stats,
    })}`
  );
  check("room A converges through actual MuxProvider", b1.getText("codemirror").toString() === "room A text");
  check("room B converges through actual MuxProvider", b2.getText("codemirror").toString() === "room B text");

  setText(b1, "room A reply");
  await waitFor(() => a1.getText("codemirror").toString() === "room A reply", 1000, "reply text");
  check("updates flow back over the shared socket", a1.getText("codemirror").toString() === "room A reply");

  providers[0].destroy();
  providers[0] = null;
  await sleep(20);
  check("destroying one mux provider leaves only that room",
    hubFor(FakeWebSocket.created[0].url).room(roomA).clients.size === 1,
    `clients=${hubFor(FakeWebSocket.created[0].url).room(roomA).clients.size}`);
  check("shared socket stays open for remaining rooms",
    FakeWebSocket.created[0].readyState === FakeWebSocket.OPEN);
} finally {
  for (const provider of providers) provider?.destroy();
  a1.destroy(); a2.destroy(); b1.destroy(); b2.destroy();
}

await waitFor(() => FakeWebSocket.created.every((ws) => ws.readyState === FakeWebSocket.CLOSED), 1000, "socket cleanup");
check("destroy closes shared sockets after last provider", FakeWebSocket.created.every((ws) => ws.readyState === FakeWebSocket.CLOSED));

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
