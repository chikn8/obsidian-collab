import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { trace } from "../utils/log";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_MUX = 6;
const MESSAGE_MUX_LEAVE = 7;
// Reconnect backoff is per shared socket, so a server outage is one retry
// loop for the whole share, not one per room. Attempts only reset after a
// room actually syncs (an accept-then-close server must still back off).
const MUX_RECONNECT_BASE_MS = 1_000;
const MUX_RECONNECT_MAX_MS = 60_000;
const MUX_RECONNECT_MIN_MS = 500;
const MUX_RECONNECT_JITTER_RATIO = 0.3;
// wake/online/visibility pokes: at most one immediate attempt per window.
const MUX_POKE_MIN_INTERVAL_MS = 5_000;
// An OPEN socket after sleep can be dead; a poke probes it and drops it if
// the server does not answer in time.
const MUX_PROBE_TIMEOUT_MS = 10_000;
// Status fan-out to rooms is leading-edge throttled and deduped per socket.
const MUX_STATUS_FLUSH_MS = 250;

type Listener = (...args: any[]) => void;

interface MuxParams {
  serverUrl: string;
  shareId: string;
  params: Record<string, string>;
}

const connections = new Map<string, MuxConnection>();

function paramsKey(params: Record<string, string>): string {
  return Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

function muxKey(args: MuxParams): string {
  return `${args.serverUrl}|${args.shareId}|${paramsKey(args.params)}`;
}

function muxUrl(args: MuxParams): string {
  const base = args.serverUrl.replace(/\/$/, "");
  const q = new URLSearchParams(args.params);
  return `${base}/${encodeURIComponent(`@${args.shareId}:__mux__`)}?${q.toString()}`;
}

export function reconnectDelayForAttempt(attempt: number, random = Math.random): number {
  const base = Math.min(MUX_RECONNECT_MAX_MS, MUX_RECONNECT_BASE_MS * Math.pow(2, Math.max(0, attempt)));
  const jitter = base * MUX_RECONNECT_JITTER_RATIO * (random() * 2 - 1);
  return Math.max(MUX_RECONNECT_MIN_MS, Math.min(MUX_RECONNECT_MAX_MS, Math.round(base + jitter)));
}

function toBytes(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

type MuxStatus = "connecting" | "connected" | "disconnected";

class MuxConnection {
  private ws: WebSocket | null = null;
  private openedWs: WebSocket | null = null;
  private providers = new Map<string, Set<MuxProvider>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private shouldConnect = true;
  private lastMessageAt = 0;
  private lastPokeAt = 0;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private errorReported = false;
  private deliveredStatus: MuxStatus | null = null;
  private pendingStatus: MuxStatus | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  // Per-room sync step 1 sent / step 2 received on the CURRENT socket. The
  // server answers each step 1 with exactly one step 2, in order, so a provider
  // is synced only once the reply to its own step 1 is in. Without this, a
  // step 2 still in flight for a provider that was just replaced (same room,
  // new empty doc) marks the new provider synced with an empty doc, and the
  // FileProvider then seeds the whole disk file as a second history.
  private step1Sent = new Map<string, number>();
  private step2Received = new Map<string, number>();

  constructor(private args: MuxParams) {
    this.connect();
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  register(provider: MuxProvider): void {
    let set = this.providers.get(provider.roomName);
    if (!set) {
      set = new Set();
      this.providers.set(provider.roomName, set);
    }
    set.add(provider);
    provider.setConnected(this.connected);
    if (this.connected) {
      provider.onSocketOpen();
      // Status is normally emitted from the socket "open" event, so a provider
      // joining an already-open connection would never hear "connected".
      // Listeners attach after the constructor registers — defer the emit.
      queueMicrotask(() => {
        if (this.connected && this.providers.get(provider.roomName)?.has(provider)) {
          provider.emitStatus("connected");
        }
      });
    }
  }

  unregister(provider: MuxProvider): void {
    const set = this.providers.get(provider.roomName);
    set?.delete(provider);
    if (set && set.size === 0) {
      this.leave(provider.roomName);
      this.providers.delete(provider.roomName);
    }
    if (this.providers.size === 0) {
      this.shouldConnect = false;
      this.clearTimers();
      this.ws?.close();
      connections.delete(muxKey(this.args));
    }
  }

  connect(): void {
    this.shouldConnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    trace("ws", "mux-connect", { shareId: this.args.shareId, attempt: this.attempts });
    // Retries during an outage stay "disconnected" to the rooms: announcing
    // every attempt was O(rooms) status events per tick.
    if (this.attempts === 0) this.setStatus("connecting");
    const ws = new WebSocket(muxUrl(this.args));
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.openedWs = ws;
      this.lastMessageAt = Date.now();
      this.step1Sent.clear();
      this.step2Received.clear();
      this.providers.forEach((set) => set.forEach((p) => {
        p.setConnected(true);
        p.onSocketOpen();
      }));
      this.setStatus("connected");
    };
    ws.onclose = () => this.handleClosed(ws);
    ws.onerror = () => {
      if (this.ws !== ws) return;
      this.reportError();
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      this.lastMessageAt = Date.now();
      this.clearProbe();
      this.handleMessage(event.data);
    };
  }

  disconnect(): void {
    this.shouldConnect = false;
    this.clearTimers();
    const ws = this.ws;
    if (!ws) return;
    // Drop the socket and notify providers NOW. A reconnect cycle (disconnect
    // then connect) swaps this.ws before the async close event fires, so the
    // ws-swap guard in handleClosed would otherwise swallow the transition.
    this.ws = null;
    this.openedWs = null;
    ws.close();
    this.notifyClosed();
    this.setStatus("disconnected", true);
  }

  /**
   * Wake/online/visibility hint. O(1) and never a burst: at most one immediate
   * attempt per MUX_POKE_MIN_INTERVAL_MS (unless forced by the user). An open
   * socket gets a liveness probe instead of a teardown; a socket waiting in
   * backoff gets one early attempt, and if that fails the backoff continues.
   */
  poke(reason: string, force = false): void {
    const now = Date.now();
    if (!force && now - this.lastPokeAt < MUX_POKE_MIN_INTERVAL_MS) return;
    this.lastPokeAt = now;
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.CONNECTING) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      this.probe(ws, reason);
      return;
    }
    trace("ws", "mux-poke-connect", { shareId: this.args.shareId, reason, attempt: this.attempts });
    this.connect();
  }

  /** A room finished a sync round-trip: the server is healthy again. */
  markSynced(): void {
    this.attempts = 0;
    this.errorReported = false;
  }

  /** Send a sync step 1 for a room; returns its sequence number on this
   *  socket, or null if the socket is not open (nothing was sent). */
  sendStep1(roomName: string, inner: Uint8Array): number | null {
    if (!this.send(roomName, inner)) return null;
    const seq = (this.step1Sent.get(roomName) ?? 0) + 1;
    this.step1Sent.set(roomName, seq);
    return seq;
  }

  step2Count(roomName: string): number {
    return this.step2Received.get(roomName) ?? 0;
  }

  send(roomName: string, inner: Uint8Array): boolean {
    if (!this.connected || !this.ws) return false;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_MUX);
    encoding.writeVarString(encoder, roomName);
    encoding.writeVarUint8Array(encoder, inner);
    this.ws.send(encoding.toUint8Array(encoder));
    return true;
  }

  leave(roomName: string): void {
    if (!this.connected || !this.ws) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_MUX_LEAVE);
    encoding.writeVarString(encoder, roomName);
    this.ws.send(encoding.toUint8Array(encoder));
  }

  private probe(ws: WebSocket, reason: string): void {
    if (this.probeTimer) return;
    const provider = this.primaryProvider();
    if (!provider) return;
    const sentAt = Date.now();
    provider.probeLiveness();
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      if (this.ws !== ws || this.lastMessageAt >= sentAt) return;
      trace("ws", "mux-probe-timeout", { shareId: this.args.shareId, reason, silentMs: Date.now() - this.lastMessageAt });
      // The socket looks open but is dead (typical after sleep): drop it and
      // let the normal backoff loop take over.
      this.ws = null;
      try { ws.close(); } catch { /* already closing */ }
      this.afterClose(ws);
    }, MUX_PROBE_TIMEOUT_MS);
  }

  private handleClosed(ws: WebSocket): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.afterClose(ws);
  }

  private afterClose(ws: WebSocket): void {
    this.clearProbe();
    // Only a socket that actually opened changes room state; a failed retry
    // leaves every room already disconnected, so there is nothing to fan out.
    if (this.openedWs === ws) {
      this.openedWs = null;
      this.notifyClosed();
    }
    this.setStatus("disconnected");
    if (!this.shouldConnect || this.providers.size === 0) return;
    const attempt = this.attempts++;
    const delay = reconnectDelayForAttempt(attempt);
    trace("ws", "mux-retry-scheduled", { shareId: this.args.shareId, attempt, delayMs: delay });
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private notifyClosed(): void {
    this.providers.forEach((set) => set.forEach((p) => {
      p.setConnected(false);
      p.setSynced(false);
      p.clearRemoteAwareness();
    }));
  }

  /** The socket is shared, so one error report per outage, not one per room. */
  private reportError(): void {
    trace("ws", "mux-socket-error", { shareId: this.args.shareId, attempt: this.attempts });
    if (this.errorReported) return;
    this.errorReported = true;
    this.primaryProvider()?.emit("connection-error");
  }

  private primaryProvider(): MuxProvider | null {
    let first: MuxProvider | null = null;
    for (const [roomName, set] of this.providers) {
      const p = set.values().next().value as MuxProvider | undefined;
      if (!p) continue;
      if (roomName.endsWith(":__manifest__")) return p;
      first ??= p;
    }
    return first;
  }

  /** Coalesce status fan-out: at most one O(rooms) delivery per window, and
   *  none when the settled status did not change. */
  private setStatus(status: MuxStatus, immediate = false): void {
    this.pendingStatus = status;
    if (immediate) {
      this.flushStatus();
      return;
    }
    if (this.statusTimer) return;
    this.statusTimer = setTimeout(() => this.flushStatus(), MUX_STATUS_FLUSH_MS);
  }

  private flushStatus(): void {
    if (this.statusTimer) {
      clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
    const status = this.pendingStatus;
    this.pendingStatus = null;
    if (!status || status === this.deliveredStatus) return;
    this.deliveredStatus = status;
    trace("ws", "mux-status", { shareId: this.args.shareId, status, rooms: this.providers.size, attempt: this.attempts });
    this.providers.forEach((set) => set.forEach((p) => p.emitStatus(status)));
  }

  private clearProbe(): void {
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.statusTimer) {
      clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
    this.clearProbe();
  }

  private handleMessage(raw: any): void {
    const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : toBytes(raw);
    const decoder = decoding.createDecoder(bytes);
    const outerType = decoding.readVarUint(decoder);
    if (outerType !== MESSAGE_MUX) return;
    const roomName = decoding.readVarString(decoder);
    const inner = decoding.readVarUint8Array(decoder);
    if (isSyncStep2(inner)) {
      this.step2Received.set(roomName, (this.step2Received.get(roomName) ?? 0) + 1);
    }
    const set = this.providers.get(roomName);
    if (!set) return;
    for (const provider of set) provider.receive(inner);
  }
}

function isSyncStep2(inner: Uint8Array): boolean {
  try {
    const decoder = decoding.createDecoder(inner);
    return decoding.readVarUint(decoder) === MESSAGE_SYNC && decoding.readVarUint(decoder) === 1;
  } catch {
    return false;
  }
}

function sharedConnection(args: MuxParams): MuxConnection {
  const key = muxKey(args);
  let conn = connections.get(key);
  if (!conn) {
    conn = new MuxConnection(args);
    connections.set(key, conn);
  }
  return conn;
}

export class MuxProvider {
  awareness: awarenessProtocol.Awareness;
  wsconnected = false;
  ws: { send: (data: Uint8Array) => void };
  private listeners = new Map<string, Set<Listener>>();
  private conn: MuxConnection;
  private synced = false;
  /** Sequence of this provider's latest step 1 on the current socket. */
  private awaitingStep2 = 0;
  private updateHandler: (update: Uint8Array, origin: any) => void;
  private awarenessHandler: (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: any
  ) => void;

  constructor(
    args: MuxParams & {
      roomName: string;
      ydoc: Y.Doc;
    }
  ) {
    this.roomName = args.roomName;
    this.ydoc = args.ydoc;
    this.awareness = new awarenessProtocol.Awareness(this.ydoc);
    this.conn = sharedConnection(args);
    this.ws = { send: (data) => this.conn.send(this.roomName, data) };

    this.updateHandler = (update: Uint8Array, origin: any) => {
      if (origin === this) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.send(encoding.toUint8Array(encoder));
    };
    this.ydoc.on("update", this.updateHandler);

    this.awarenessHandler = ({ added, updated, removed }, origin) => {
      if (origin === this) {
        trace("awareness", "mux-remote-applied", {
          room: this.roomName,
          added: added.length,
          updated: updated.length,
          removed: removed.length,
          states: this.awareness.getStates().size,
        });
        return;
      }
      const changedClients = added.concat(updated, removed);
      const local = this.awareness.getLocalState();
      trace("awareness", "mux-send", {
        room: this.roomName,
        added: added.length,
        updated: updated.length,
        removed: removed.length,
        hasLocalUser: !!local?.user,
        hasLocalCursor: !!local?.cursor,
        clients: changedClients.length,
      });
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients)
      );
      this.send(encoding.toUint8Array(encoder));
    };
    this.awareness.on("update", this.awarenessHandler);

    this.conn.register(this);
  }

  roomName: string;
  ydoc: Y.Doc;

  on(event: string, listener: Listener): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }

  off(event: string, listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, ...args: any[]): void {
    this.listeners.get(event)?.forEach((listener) => listener(...args));
  }

  emitStatus(status: string): void {
    this.emit("status", { status });
  }

  setConnected(connected: boolean): void {
    this.wsconnected = connected;
  }

  setSynced(synced: boolean): void {
    if (synced) this.conn.markSynced();
    if (this.synced === synced) return;
    this.synced = synced;
    this.emit("sync", synced);
  }

  onSocketOpen(): void {
    this.sendSyncStep1();
    this.flushLocalAwareness();
  }

  /** Drop remote presence when the socket closes (mirrors y-websocket) —
   *  otherwise ghost cursors linger until the 30s awareness timeout. */
  clearRemoteAwareness(): void {
    const remote = Array.from(this.awareness.getStates().keys())
      .filter((clientId) => clientId !== this.awareness.clientID);
    if (remote.length > 0) awarenessProtocol.removeAwarenessStates(this.awareness, remote, this);
  }

  connect(): void {
    this.conn.connect();
  }

  disconnect(): void {
    this.conn.disconnect();
  }

  /** Ask the shared socket to recover (wake/online/visibility/manual). Cheap
   *  to call for every room: the connection throttles and dedupes. */
  requestReconnect(reason: string, force = false): void {
    this.conn.poke(reason, force);
  }

  /** Liveness probe: the server answers sync step 1 with step 2. */
  probeLiveness(): void {
    this.sendSyncStep1();
  }

  destroy(): void {
    this.ydoc.off("update", this.updateHandler);
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.awareness.clientID], "destroy");
    this.awareness.off("update", this.awarenessHandler);
    this.awareness.destroy();
    this.conn.unregister(this);
    this.listeners.clear();
  }

  receive(message: Uint8Array): void {
    const decoder = decoding.createDecoder(message);
    const messageType = decoding.readVarUint(decoder);
    if (messageType === MESSAGE_SYNC) {
      const subtype = decoding.readVarUint(decoding.clone(decoder));
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, this.ydoc, this);
      if (encoding.length(encoder) > 1) this.send(encoding.toUint8Array(encoder));
      // Only the reply to OUR latest step 1 proves we hold the server's state.
      if (subtype === 1 && this.conn.step2Count(this.roomName) >= this.awaitingStep2) this.setSynced(true);
    } else if (messageType === MESSAGE_AWARENESS) {
      const update = decoding.readVarUint8Array(decoder);
      trace("awareness", "mux-receive", {
        room: this.roomName,
        bytes: update.byteLength,
        statesBefore: this.awareness.getStates().size,
      });
      awarenessProtocol.applyAwarenessUpdate(this.awareness, update, this);
    }
  }

  private sendSyncStep1(): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, this.ydoc);
    const seq = this.conn.sendStep1(this.roomName, encoding.toUint8Array(encoder));
    if (seq != null) this.awaitingStep2 = seq;
  }

  private flushLocalAwareness(): void {
    const local = this.awareness.getLocalState();
    if (!local) return;
    trace("awareness", "mux-flush-local", {
      room: this.roomName,
      hasLocalUser: !!local.user,
      hasLocalCursor: !!local.cursor,
      states: this.awareness.getStates().size,
    });
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.awareness.clientID])
    );
    this.send(encoding.toUint8Array(encoder));
  }

  private send(message: Uint8Array): void {
    this.conn.send(this.roomName, message);
  }
}
