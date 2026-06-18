import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_MUX = 6;

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

function toBytes(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

class MuxConnection {
  private ws: WebSocket | null = null;
  private providers = new Map<string, Set<MuxProvider>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private shouldConnect = true;

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
    if (this.connected) provider.onSocketOpen();
  }

  unregister(provider: MuxProvider): void {
    const set = this.providers.get(provider.roomName);
    set?.delete(provider);
    if (set && set.size === 0) this.providers.delete(provider.roomName);
    if (this.providers.size === 0) {
      this.shouldConnect = false;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
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
    this.providers.forEach((set) => set.forEach((p) => p.emitStatus("connecting")));
    const ws = new WebSocket(muxUrl(this.args));
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempts = 0;
      this.providers.forEach((set) => set.forEach((p) => {
        p.setConnected(true);
        p.emitStatus("connected");
        p.onSocketOpen();
      }));
    };
    ws.onclose = () => this.handleClosed(ws);
    ws.onerror = () => {
      if (this.ws !== ws) return;
      this.providers.forEach((set) => set.forEach((p) => p.emit("connection-error")));
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      this.handleMessage(event.data);
    };
  }

  disconnect(): void {
    this.shouldConnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
  }

  send(roomName: string, inner: Uint8Array): void {
    if (!this.connected || !this.ws) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_MUX);
    encoding.writeVarString(encoder, roomName);
    encoding.writeVarUint8Array(encoder, inner);
    this.ws.send(encoding.toUint8Array(encoder));
  }

  private handleClosed(ws: WebSocket): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.providers.forEach((set) => set.forEach((p) => {
      p.setConnected(false);
      p.setSynced(false);
      p.emitStatus("disconnected");
    }));
    if (!this.shouldConnect || this.providers.size === 0) return;
    const delay = Math.min(10_000, 500 * Math.pow(2, this.attempts++));
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private handleMessage(raw: any): void {
    const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : toBytes(raw);
    const decoder = decoding.createDecoder(bytes);
    const outerType = decoding.readVarUint(decoder);
    if (outerType !== MESSAGE_MUX) return;
    const roomName = decoding.readVarString(decoder);
    const inner = decoding.readVarUint8Array(decoder);
    const set = this.providers.get(roomName);
    if (!set) return;
    for (const provider of set) provider.receive(inner);
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
  private updateHandler: (update: Uint8Array, origin: any) => void;
  private awarenessHandler: ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => void;

  constructor(
    args: MuxParams & {
      roomName: string;
      ydoc: Y.Doc;
    }
  ) {
    this.roomName = args.roomName;
    this.ydoc = args.ydoc;
    this.awareness = new awarenessProtocol.Awareness(this.ydoc);
    this.awareness.setLocalState(null);
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

    this.awarenessHandler = ({ added, updated, removed }) => {
      const changedClients = added.concat(updated, removed);
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
    if (this.synced === synced) return;
    this.synced = synced;
    this.emit("sync", synced);
  }

  onSocketOpen(): void {
    this.sendSyncStep1();
    this.flushLocalAwareness();
  }

  connect(): void {
    this.conn.connect();
  }

  disconnect(): void {
    this.conn.disconnect();
  }

  destroy(): void {
    this.ydoc.off("update", this.updateHandler);
    this.awareness.off("update", this.awarenessHandler);
    awarenessProtocol.removeAwarenessStates(this.awareness, Array.from(this.awareness.getStates().keys()), this);
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
      if (subtype === 1) this.setSynced(true);
    } else if (messageType === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
    }
  }

  private sendSyncStep1(): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, this.ydoc);
    this.send(encoding.toUint8Array(encoder));
  }

  private flushLocalAwareness(): void {
    const local = this.awareness.getLocalState();
    if (!local) return;
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
