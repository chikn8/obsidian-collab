import { WebSocket, type RawData } from "ws";
import type { IncomingMessage } from "http";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { loadState, saveState, startPeriodicSave, stopPeriodicSave } from "./persistence.js";
import { handleNotify, registerTopic } from "./notify.js";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
// 2 = messageAuth, 3 = messageQueryAwareness are reserved by y-websocket.
const MESSAGE_NOTIFY = 4; // {fromUid, fromName, toUid, title, body} — mention push
const MESSAGE_TOPIC_REGISTER = 5; // {uid, topic} — register ntfy topic

const PING_INTERVAL = 30000;

// ── Abuse caps (one authed client must not be able to OOM/bloat the box) ──────
const MAX_MSGS_PER_SEC = 250;            // sustained inbound rate per connection
const RATE_BURST = 600;                  // bucket capacity (covers a big paste)
const SEND_BUFFER_LIMIT = 8 * 1024 * 1024; // drop a hopelessly backed-up socket (slow-peer OOM guard)
let rateLimitedCount = 0;
let backpressureClosedCount = 0;

/** Per-connection token-bucket rate limit. Returns false when over budget. */
function allowMessage(conn: any): boolean {
  const now = Date.now();
  let b = conn._bucket;
  if (!b) { b = conn._bucket = { tokens: RATE_BURST, ts: now }; }
  const elapsed = (now - b.ts) / 1000;
  b.ts = now;
  b.tokens = Math.min(RATE_BURST, b.tokens + elapsed * MAX_MSGS_PER_SEC);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/**
 * A Yjs document shared across all connected clients in a room.
 */
class WSSharedDoc extends Y.Doc {
  name: string;
  conns: Map<WebSocket, Set<number>>;
  awareness: awarenessProtocol.Awareness;

  constructor(name: string) {
    super({ gc: true });
    this.name = name;
    this.conns = new Map();
    this.awareness = new awarenessProtocol.Awareness(this);
    this.awareness.setLocalState(null);

    // Broadcast awareness changes to all connected clients
    this.awareness.on(
      "update",
      ({
        added,
        updated,
        removed,
      }: {
        added: number[];
        updated: number[];
        removed: number[];
      }) => {
        const changedClients = added.concat(updated, removed);
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(
            this.awareness,
            changedClients
          )
        );
        const message = encoding.toUint8Array(encoder);
        this.conns.forEach((_, conn) => {
          send(conn, message);
        });
      }
    );

    // Broadcast document updates to all connected clients
    this.on("update", (update: Uint8Array, origin: any) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);
      this.conns.forEach((_, conn) => {
        if (origin !== conn) {
          send(conn, message);
        }
      });
    });
  }
}

// Room registry
const docs: Map<string, WSSharedDoc> = new Map();
const docLoads: Map<string, Promise<WSSharedDoc>> = new Map();

/** Lightweight server metrics for /metrics (reads live in-memory state). */
export function getMetrics() {
  let connections = 0;
  const rooms: { room: string; conns: number; clients: number }[] = [];
  for (const [name, doc] of docs) {
    connections += doc.conns.size;
    rooms.push({ room: name, conns: doc.conns.size, clients: doc.awareness.getStates().size });
  }
  return {
    rooms: docs.size,
    connections,
    rateLimited: rateLimitedCount,
    backpressureClosed: backpressureClosedCount,
    detail: rooms.sort((a, b) => b.conns - a.conns).slice(0, 100),
  };
}

/**
 * Get or create a shared document for a room.
 */
async function getOrCreateDoc(roomName: string): Promise<WSSharedDoc> {
  let doc = docs.get(roomName);
  if (doc) return doc;

  const pending = docLoads.get(roomName);
  if (pending) return pending;

  const load = (async () => {
    const loadedDoc = new WSSharedDoc(roomName);

    // Load persisted state before exposing the room to any connection.
    await loadState(roomName, loadedDoc);

    docs.set(roomName, loadedDoc);

    // Start periodic saves for crash resilience
    startPeriodicSave(roomName, loadedDoc);

    return loadedDoc;
  })();

  docLoads.set(roomName, load);
  try {
    return await load;
  } finally {
    docLoads.delete(roomName);
  }
}

export async function saveAllDocs(reason = "manual"): Promise<void> {
  const entries = Array.from(docs.entries());
  if (entries.length === 0) return;
  console.log(`[rooms] saving ${entries.length} active room(s): ${reason}`);
  const results = await Promise.allSettled(entries.map(([roomName, doc]) => saveState(roomName, doc)));
  for (const [i, result] of results.entries()) {
    if (result.status === "rejected") {
      console.error(`[rooms] final save failed for ${entries[i][0]}:`, result.reason);
    }
  }
}

export function closeRevokedConnections(shareId: string, minEpoch: number): number {
  let closed = 0;
  const prefix = `@${shareId}:`;
  for (const [roomName, doc] of docs) {
    if (!roomName.startsWith(prefix)) continue;
    for (const conn of doc.conns.keys()) {
      const connShareId = (conn as any).collabShareId;
      const connEpoch = Number((conn as any).collabEpoch ?? 0);
      if (connShareId === shareId && connEpoch < minEpoch) {
        closed++;
        conn.close(4003, "Share access revoked");
      }
    }
  }
  if (closed > 0) console.log(`[rooms] closed ${closed} revoked connection(s) for share ${shareId}`);
  return closed;
}

/**
 * Send a binary message to a WebSocket client.
 */
function send(conn: WebSocket, message: Uint8Array): void {
  if (conn.readyState !== WebSocket.OPEN) return;
  // Backpressure: a slow/cellular peer that can't drain makes the server buffer
  // unbounded send data → OOM. Close it; it reconnects and re-syncs cleanly.
  if (conn.bufferedAmount > SEND_BUFFER_LIMIT) {
    backpressureClosedCount++;
    console.warn(`[rooms] backpressure: closing slow connection (buffered ${conn.bufferedAmount})`);
    closeConn(conn);
    return;
  }
  try {
    conn.send(message, (err) => {
      if (err) {
        console.error("[rooms] send error:", err);
        closeConn(conn);
      }
    });
  } catch (e) {
    closeConn(conn);
  }
}

/**
 * Handle an incoming message from a client.
 */
function handleMessage(
  conn: WebSocket,
  doc: WSSharedDoc,
  message: Uint8Array
): void {
  try {
    const decoder = decoding.createDecoder(message);
    const messageType = decoding.readVarUint(decoder);

    switch (messageType) {
      case MESSAGE_SYNC: {
        // Permission boundary: non-editors may READ (sync step1 = sub-type 0)
        // but their WRITES (step2 = 1, update = 2) are dropped here — un-applied
        // and un-persisted, since doc.on('update') is the only fan-out. This is
        // the real read-only enforcement (the client UI is just cosmetic).
        const role = (conn as any).collabRole || "editor";
        if (role !== "editor") {
          const sub = decoding.readVarUint(decoding.clone(decoder));
          if (sub === 1 || sub === 2) {
            return; // viewer/commenter write — ignore
          }
        }
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(decoder, encoder, doc, conn);
        if (encoding.length(encoder) > 1) {
          send(conn, encoding.toUint8Array(encoder));
        }
        break;
      }
      case MESSAGE_AWARENESS: {
        awarenessProtocol.applyAwarenessUpdate(
          doc.awareness,
          decoding.readVarUint8Array(decoder),
          conn
        );
        break;
      }
      case MESSAGE_NOTIFY: {
        // Mention push, scoped to the SENDER's authed share. Viewers can't send.
        if (((conn as any).collabRole || "editor") === "viewer") return;
        try {
          const shareId = (conn as any).collabShareId ?? null;
          void handleNotify(shareId, JSON.parse(decoding.readVarString(decoder)), Date.now()).catch((e) => {
            console.error("[rooms] notify failed:", e);
          });
        } catch { /* ignore */ }
        break;
      }
      case MESSAGE_TOPIC_REGISTER: {
        // Register the caller's own ntfy topic, scoped to its authed share.
        try {
          const p = JSON.parse(decoding.readVarString(decoder));
          const shareId = (conn as any).collabShareId ?? null;
          void registerTopic(shareId, p.uid, p.topic).catch((e) => {
            console.error("[rooms] topic register failed:", e);
          });
        } catch { /* ignore */ }
        break;
      }
      default:
        console.warn("[rooms] unknown message type:", messageType);
    }
  } catch (e) {
    console.error("[rooms] message handling error:", e);
  }
}

/**
 * Close a connection and clean up.
 */
function closeConn(conn: WebSocket): void {
  // Find which doc this connection belongs to
  for (const [roomName, doc] of docs) {
    const controlledIds = doc.conns.get(conn);
    if (!controlledIds) continue;

    doc.conns.delete(conn);

    // Remove awareness states for this client
    awarenessProtocol.removeAwarenessStates(
      doc.awareness,
      Array.from(controlledIds),
      null
    );

    console.log(
      `[rooms] client disconnected from ${roomName} (${doc.conns.size} remaining)`
    );

    // If no clients remain, persist and clean up
    if (doc.conns.size === 0) {
      stopPeriodicSave(roomName);
      saveState(roomName, doc)
        .then(() => {
          doc.destroy();
          docs.delete(roomName);
          console.log(`[rooms] room ${roomName} closed and persisted`);
        })
        .catch((e) => {
          console.error("[rooms] persistence error:", e);
        });
    }

    break;
  }

  try {
    conn.close();
  } catch (e) {
    // Already closed
  }
}

/**
 * Set up a new WebSocket connection for collaboration.
 * Called when a client connects to the server.
 */
export async function setupWSConnection(
  conn: WebSocket,
  req: IncomingMessage
): Promise<void> {
  // Extract room name from URL path
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const roomName = decodeURIComponent(url.pathname.slice(1).split("?")[0]);

  if (!roomName) {
    console.error("[rooms] no room name provided");
    conn.close(4000, "No room name");
    return;
  }

  const doc = await getOrCreateDoc(roomName);

  // Carry the role granted at the auth/upgrade step (default editor).
  (conn as any).collabRole = (req as any).collabRole || "editor";
  (conn as any).collabShareId = (req as any).collabShareId || null;
  (conn as any).collabEpoch = (req as any).collabEpoch ?? 0;

  // Track this connection
  doc.conns.set(conn, new Set());

  console.log(
    `[rooms] client connected to ${roomName} (${doc.conns.size} total)`
  );

  // Handle incoming messages
  conn.on("message", (data: RawData) => {
    // Drop messages from a connection exceeding its rate budget (flood guard).
    if (!allowMessage(conn)) {
      if (++rateLimitedCount % 100 === 1) console.warn(`[rooms] rate-limited a connection on ${roomName}`);
      return;
    }
    const message =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(
            data instanceof Buffer
              ? data.buffer.slice(
                  data.byteOffset,
                  data.byteOffset + data.byteLength
                )
              : (data as any)
          );
    handleMessage(conn, doc, message);
  });

  // Handle disconnect
  conn.on("close", () => {
    closeConn(conn);
  });

  conn.on("error", (err) => {
    console.error("[rooms] connection error:", err);
    closeConn(conn);
  });

  // Set up ping/pong keepalive
  let alive = true;
  const pingInterval = setInterval(() => {
    if (!alive) {
      closeConn(conn);
      clearInterval(pingInterval);
      return;
    }
    alive = false;
    try {
      conn.ping();
    } catch (e) {
      closeConn(conn);
      clearInterval(pingInterval);
    }
  }, PING_INTERVAL);

  conn.on("pong", () => {
    alive = true;
  });

  conn.on("close", () => {
    clearInterval(pingInterval);
  });

  // Send initial sync step 1
  {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, doc);
    send(conn, encoding.toUint8Array(encoder));
  }

  // Send current awareness states
  const awarenessStates = doc.awareness.getStates();
  if (awarenessStates.size > 0) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(
        doc.awareness,
        Array.from(awarenessStates.keys())
      )
    );
    send(conn, encoding.toUint8Array(encoder));
  }
}
