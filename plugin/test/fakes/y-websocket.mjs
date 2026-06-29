/**
 * In-memory fake of y-websocket: an internal hub relays Yjs updates between all
 * providers sharing a room name (one process, no network). Enough surface for
 * YjsProvider.createProvider + FileProvider to run the REAL sync loop, including
 * disconnect/reconnect for offline simulation.
 */
import * as Y from "yjs";

const hubs = new Map(); // roomName -> { doc, conns:Set }
function hub(room) {
  let h = hubs.get(room);
  if (!h) { h = { doc: new Y.Doc(), conns: new Set() }; hubs.set(room, h); }
  return h;
}
export const __createdProviders = [];
export function __resetHubs() { hubs.clear(); __createdProviders.length = 0; }

let nextClientId = 1;

class FakeAwareness {
  constructor() { this.clientID = nextClientId++; this.states = new Map(); this.meta = new Map(); this._cbs = new Set(); }
  setLocalState(s) { if (s == null) this.states.delete(this.clientID); else this.states.set(this.clientID, s); this._emit(); }
  setLocalStateField(field, value) {
    const cur = this.states.get(this.clientID) || {};
    this.states.set(this.clientID, { ...cur, [field]: value });
    this._emit();
  }
  getLocalState() { return this.states.get(this.clientID) || null; }
  getStates() { return this.states; }
  on(_ev, cb) { this._cbs.add(cb); }
  off(_ev, cb) { this._cbs.delete(cb); }
  _emit() { for (const cb of this._cbs) cb({ added: [], updated: [this.clientID], removed: [] }); }
}

export class WebsocketProvider {
  constructor(_url, room, doc, opts = {}) {
    this.room = room;
    this.doc = doc;
    __createdProviders.push({ url: _url, room, params: opts.params || {} });
    this.awareness = new FakeAwareness();
    this.synced = false;
    this.wsconnected = false;
    this.wsUnsuccessfulReconnects = 0;
    this._handlers = { status: new Set(), sync: new Set(), "connection-error": new Set() };
    this._onDocUpdate = (u, origin) => {
      if (!this.wsconnected || origin === "hub") return;
      this._broadcast(u);
    };
    if (opts.connect !== false) this.connect();
  }
  on(ev, cb) { this._handlers[ev]?.add(cb); }
  once(ev, cb) { const w = (a) => { this._handlers[ev]?.delete(w); cb(a); }; this._handlers[ev]?.add(w); }
  off(ev, cb) { this._handlers[ev]?.delete(cb); }
  _emit(ev, arg) { for (const cb of [...(this._handlers[ev] || [])]) cb(arg); }

  _broadcast(update) {
    const h = hub(this.room);
    Y.applyUpdate(h.doc, update, this);
    for (const conn of h.conns) if (conn !== this) Y.applyUpdate(conn.doc, update, "hub");
  }

  connect() {
    if (this.wsconnected) return;
    const h = hub(this.room);
    // Adopt current room state, then publish ours so peers converge.
    Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(h.doc), "hub");
    Y.applyUpdate(h.doc, Y.encodeStateAsUpdate(this.doc), this);
    const mine = Y.encodeStateAsUpdate(this.doc);
    for (const conn of h.conns) if (conn !== this) Y.applyUpdate(conn.doc, mine, "hub");
    h.conns.add(this);
    this.wsconnected = true;
    this.doc.on("update", this._onDocUpdate);
    // status/sync fire async like the real provider
    Promise.resolve().then(() => {
      this._emit("status", { status: "connected" });
      this.synced = true;
      this._emit("sync", true);
    });
  }
  disconnect() {
    if (!this.wsconnected) return;
    hub(this.room).conns.delete(this);
    this.doc.off("update", this._onDocUpdate);
    this.wsconnected = false;
    this.synced = false;
    this._emit("status", { status: "disconnected" });
  }
  simulateConnectionError(error = new Error("simulated connection error")) {
    this._emit("connection-error", error);
  }
  destroy() { this.disconnect(); this.awareness.setLocalState(null); }
}
