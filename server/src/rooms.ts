import { WebSocket, type RawData } from "ws";
import type { IncomingMessage } from "http";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { loadState, markDirty, saveState, startPeriodicSave, stopPeriodicSave } from "./persistence.js";
import { handleNotify, registerTopic } from "./notify.js";
import { logEvent } from "./logging.js";
import { auditEvent } from "./audit.js";
import { getMetricCounters, incMetric } from "./metrics.js";
import { getMinEpoch } from "./shareState.js";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
// 2 = messageAuth, 3 = messageQueryAwareness are reserved by y-websocket.
const MESSAGE_NOTIFY = 4; // {fromUid, fromName, toUid, title, body} — mention push
const MESSAGE_TOPIC_REGISTER = 5; // {uid, topic} — register ntfy topic
const MESSAGE_MUX = 6; // outer frame: roomName + inner y-websocket frame
const MESSAGE_MUX_LEAVE = 7; // outer frame: roomName, unsubscribe one mux room

const PING_INTERVAL = 30000;
const SYNC_DEBUG_LOG = process.env.SYNC_DEBUG_LOG === "true";
const LARGE_UPDATE_BYTES = Number(process.env.SYNC_LOG_LARGE_UPDATE_BYTES || 64 * 1024);
const LARGE_TEXT_DELTA = Number(process.env.SYNC_LOG_LARGE_TEXT_DELTA || 20 * 1024);
const BLOCKED_FILE_SEGMENTS = (process.env.SYNC_BLOCKED_FILE_SEGMENTS || "node_modules,.git")
  .split(",")
  .map((segment) => segment.trim())
  .filter(Boolean);

// ── Abuse caps (one authed client must not be able to OOM/bloat the box) ──────
const MAX_MSGS_PER_SEC = 250;            // sustained inbound rate per connection
const RATE_BURST = 600;                  // bucket capacity (covers a big paste)
const RATE_LIMIT_CLOSE_CODE = 4408;
const SEND_BUFFER_LIMIT = 8 * 1024 * 1024; // drop a hopelessly backed-up socket (slow-peer OOM guard)
let rateLimitedCount = 0;
let backpressureClosedCount = 0;
let blockedRoomCount = 0;
let nextConnId = 1;
const activeMuxConnections = new Set<WebSocket>();

type RoomStats = {
  inboundSyncMessages: number;
  inboundBytes: number;
  maxInboundBytes: number;
  suspiciousUpdates: number;
  lastUpdateAt: number;
  textLen: number | null;
  maxTextLen: number | null;
};

interface CollabIdentity {
  uid: string;
  name: string;
  color: string;
  baseColor: string;
  device?: string;
  deviceId?: string;
}

function roomInfo(room: string): { shareId: string; kind: string; relPath?: string } {
  let rest = room;
  let shareId = "legacy";
  if (rest.startsWith("@")) {
    const idx = rest.indexOf(":");
    shareId = idx >= 0 ? rest.slice(1, idx) : "";
    rest = idx >= 0 ? rest.slice(idx + 1) : rest;
  }
  if (rest === "__manifest__") return { shareId, kind: "manifest" };
  if (rest.startsWith("file:")) return { shareId, kind: "file", relPath: decodeURIComponent(rest.slice(5)) };
  return { shareId, kind: "other" };
}

function blockedRoomReason(room: string): string | null {
  const info = roomInfo(room);
  if (info.kind !== "file" || !info.relPath) return null;
  const parts = info.relPath.split("/").filter(Boolean);
  for (const segment of BLOCKED_FILE_SEGMENTS) {
    if (parts.includes(segment)) return `blocked-segment:${segment}`;
  }
  return null;
}

function syncSubtypeName(subtype: number): string {
  if (subtype === 0) return "step1";
  if (subtype === 1) return "step2";
  if (subtype === 2) return "update";
  return `unknown:${subtype}`;
}

function fileTextLen(doc: WSSharedDoc): number | null {
  if (roomInfo(doc.name).kind !== "file") return null;
  return doc.getText("codemirror").length;
}

function stateBytes(doc: Y.Doc): number {
  return Y.encodeStateAsUpdate(doc).byteLength;
}

function rawDataToUint8Array(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  const buffer = Array.isArray(data) ? Buffer.concat(data) : data;
  if (buffer instanceof Buffer) {
    return new Uint8Array(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    );
  }
  return new Uint8Array(buffer as any);
}

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

function closeRateLimitedConnection(conn: WebSocket, event: string, fields: Record<string, unknown>): void {
  incMetric("rate_limited");
  if (++rateLimitedCount % 100 === 1) {
    logEvent("warn", event, { ...fields, count: rateLimitedCount });
  }
  if (conn.readyState === WebSocket.OPEN || conn.readyState === WebSocket.CONNECTING) {
    conn.close(RATE_LIMIT_CLOSE_CODE, "Rate limit exceeded");
  }
}

function cleanParam(value: string | null, fallback: string, max: number, pattern?: RegExp): string {
  const clean = (value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
  if (!clean) return fallback;
  if (pattern && !pattern.test(clean)) return fallback;
  return clean;
}

function identityFromUrl(url: URL, connId: number): CollabIdentity {
  const uid = cleanParam(url.searchParams.get("uid"), `conn-${connId}`, 128, /^[A-Za-z0-9_-]+$/);
  const name = cleanParam(url.searchParams.get("name"), "Anonymous", 80);
  const color = cleanParam(url.searchParams.get("color"), "#888888", 16, /^#[0-9a-fA-F]{6}$/);
  const baseColor = cleanParam(url.searchParams.get("baseColor"), color, 16, /^#[0-9a-fA-F]{6}$/);
  const device = cleanParam(url.searchParams.get("device"), "", 24, /^[A-Za-z0-9_-]+$/) || undefined;
  const deviceId = cleanParam(url.searchParams.get("deviceId"), "", 128, /^[A-Za-z0-9_.:-]+$/) || undefined;
  return { uid, name, color, baseColor, device, deviceId };
}

export function sanitizeAwarenessStateForTest(state: any, identity: CollabIdentity): any {
  if (state == null || typeof state !== "object") return state;
  return {
    ...state,
    user: {
      ...(state.user || {}),
      uid: identity.uid,
      name: identity.name,
      color: identity.color,
      baseColor: identity.baseColor,
      colorLight: `${identity.color}33`,
      device: identity.device,
      deviceId: identity.deviceId,
    },
  };
}

function ownerOfAwarenessClient(doc: WSSharedDoc, clientId: number): WebSocket | null {
  for (const [conn, ids] of doc.conns) {
    if (ids.has(clientId)) return conn;
  }
  return null;
}

function filterAndStampAwarenessUpdate(
  doc: WSSharedDoc,
  conn: WebSocket,
  update: Uint8Array
): { update: Uint8Array; entries: { clientId: number; state: any }[] } | null {
  const identity = (conn as any).collabIdentity as CollabIdentity;
  const controlled = doc.conns.get(conn);
  if (!identity || !controlled) return null;

  const decoder = decoding.createDecoder(update);
  const len = decoding.readVarUint(decoder);
  const entries: { clientId: number; clock: number; state: any }[] = [];
  for (let i = 0; i < len; i++) {
    const clientId = decoding.readVarUint(decoder);
    const clock = decoding.readVarUint(decoder);
    const state = JSON.parse(decoding.readVarString(decoder));
    const owner = ownerOfAwarenessClient(doc, clientId);
    const owns = controlled.has(clientId);

    if (state === null) {
      if (owns) entries.push({ clientId, clock, state });
      continue;
    }

    if (owner && owner !== conn) {
      incMetric("rejected_awareness");
      logEvent("warn", "awareness.rejected_foreign_client", {
        room: doc.name,
        ...roomInfo(doc.name),
        connId: (conn as any).collabConnId,
        clientId,
      });
      void auditEvent("awareness.rejected_foreign_client", {
        room: doc.name,
        ...roomInfo(doc.name),
        connId: (conn as any).collabConnId,
        uid: (conn as any).collabIdentity?.uid,
        clientId,
      });
      continue;
    }

    entries.push({ clientId, clock, state: sanitizeAwarenessStateForTest(state, identity) });
  }

  if (entries.length === 0) return null;
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, entries.length);
  for (const entry of entries) {
    encoding.writeVarUint(encoder, entry.clientId);
    encoding.writeVarUint(encoder, entry.clock);
    encoding.writeVarString(encoder, JSON.stringify(entry.state));
  }
  return { update: encoding.toUint8Array(encoder), entries };
}

/**
 * A Yjs document shared across all connected clients in a room.
 */
class WSSharedDoc extends Y.Doc {
  name: string;
  conns: Map<WebSocket, Set<number>>;
  awareness: awarenessProtocol.Awareness;
  stats: RoomStats;

  constructor(name: string) {
    super({ gc: true });
    this.name = name;
    this.conns = new Map();
    this.awareness = new awarenessProtocol.Awareness(this);
    this.stats = {
      inboundSyncMessages: 0,
      inboundBytes: 0,
      maxInboundBytes: 0,
      suspiciousUpdates: 0,
      lastUpdateAt: 0,
      textLen: null,
      maxTextLen: null,
    };
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
          send(conn, message, this.name);
        });
      }
    );

    // Broadcast document updates to all connected clients
    this.on("update", (update: Uint8Array, origin: any) => {
      if (origin !== "load") {
        this.stats.lastUpdateAt = Date.now();
        markDirty(this.name);
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);
      this.conns.forEach((_, conn) => {
        if (origin !== conn) {
          send(conn, message, this.name);
        }
      });
    });
  }
}

// Room registry
const docs: Map<string, WSSharedDoc> = new Map();
const docLoads: Map<string, Promise<WSSharedDoc>> = new Map();
const connRooms: WeakMap<WebSocket, Set<string>> = new WeakMap();

function rememberConnRoom(conn: WebSocket, roomName: string): void {
  let rooms = connRooms.get(conn);
  if (!rooms) {
    rooms = new Set();
    connRooms.set(conn, rooms);
  }
  rooms.add(roomName);
}

function takeConnRooms(conn: WebSocket): string[] {
  const rooms = connRooms.get(conn);
  if (!rooms) return [];
  connRooms.delete(conn);
  return Array.from(rooms);
}

function forgetConnRoom(conn: WebSocket, roomName: string): void {
  const rooms = connRooms.get(conn);
  if (!rooms) return;
  rooms.delete(roomName);
  if (rooms.size === 0) connRooms.delete(conn);
}

function closeRoomIfIdle(roomName: string, doc: WSSharedDoc): void {
  if (doc.conns.size !== 0) return;
  stopPeriodicSave(roomName);
  saveState(roomName, doc)
    .then(() => {
      if (docs.get(roomName) !== doc || doc.conns.size > 0) {
        logEvent("info", "room.close_aborted", {
          room: roomName,
          ...roomInfo(roomName),
          conns: doc.conns.size,
        });
        return;
      }
      doc.destroy();
      docs.delete(roomName);
      logEvent("info", "room.closed", {
        room: roomName,
        ...roomInfo(roomName),
      });
    })
    .catch((e) => {
      logEvent("error", "room.close_persist_failed", {
        room: roomName,
        ...roomInfo(roomName),
        error: e,
      });
    });
}

/** Lightweight server metrics for /metrics (reads live in-memory state). */
export function getMetrics() {
  let connections = 0;
  const rooms: { room: string; conns: number; clients: number; stats: RoomStats }[] = [];
  for (const [name, doc] of docs) {
    connections += doc.conns.size;
    const textLen = fileTextLen(doc);
    rooms.push({
      room: name,
      conns: doc.conns.size,
      clients: doc.awareness.getStates().size,
      stats: { ...doc.stats, textLen },
    });
  }
  return {
    rooms: docs.size,
    connections,
    muxConnections: activeMuxConnections.size,
    rateLimited: rateLimitedCount,
    backpressureClosed: backpressureClosedCount,
    blockedRooms: blockedRoomCount,
    counters: getMetricCounters(),
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
  logEvent("info", "rooms.save_all_start", { rooms: entries.length, reason });
  const results = await Promise.allSettled(entries.map(([roomName, doc]) => saveState(roomName, doc)));
  for (const [i, result] of results.entries()) {
    if (result.status === "rejected") {
      logEvent("error", "rooms.save_all_failed", {
        room: entries[i][0],
        ...roomInfo(entries[i][0]),
        reason,
        error: result.reason,
      });
    }
  }
}

function ensureConnectionIdentity(conn: WebSocket, req: IncomingMessage, url: URL): void {
  if ((conn as any).collabConnId !== undefined) return;
  (conn as any).collabConnId = nextConnId++;
  (conn as any).collabRole = (req as any).collabRole || "editor";
  (conn as any).collabShareId = (req as any).collabShareId || null;
  (conn as any).collabEpoch = (req as any).collabEpoch ?? 0;
  (conn as any).collabInviteId = (req as any).collabInviteId || null;
  (conn as any).collabIdentity = identityFromUrl(url, (conn as any).collabConnId);
}

function muxRoomAllowed(conn: WebSocket, roomName: string): boolean {
  const shareId = (conn as any).collabShareId;
  if (!shareId) return false;
  if (roomName === `@${shareId}:__mux__`) return false;
  return roomName.startsWith(`@${shareId}:`);
}

async function joinRoom(conn: WebSocket, req: IncomingMessage, roomName: string, url: URL): Promise<WSSharedDoc | null> {
  ensureConnectionIdentity(conn, req, url);
  const blockedReason = blockedRoomReason(roomName);
  if (blockedReason) {
    incMetric("rejected_paths");
    if (++blockedRoomCount % 100 === 1) {
      logEvent("warn", "room.blocked", {
        room: roomName,
        ...roomInfo(roomName),
        connId: (conn as any).collabConnId,
        uid: (conn as any).collabIdentity?.uid,
        mux: !!(conn as any).collabMux,
        reason: blockedReason,
        count: blockedRoomCount,
      });
    }
    return null;
  }
  const doc = await getOrCreateDoc(roomName);
  if (conn.readyState !== WebSocket.OPEN) {
    logEvent("info", "room.join_aborted_closed", {
      room: roomName,
      ...roomInfo(roomName),
      connId: (conn as any).collabConnId,
      mux: !!(conn as any).collabMux,
    });
    closeRoomIfIdle(roomName, doc);
    return null;
  }
  startPeriodicSave(roomName, doc);
  if (doc.conns.has(conn)) {
    rememberConnRoom(conn, roomName);
    return doc;
  }

  doc.conns.set(conn, new Set());
  rememberConnRoom(conn, roomName);

  logEvent("info", "room.connect", {
    room: roomName,
    ...roomInfo(roomName),
    connId: (conn as any).collabConnId,
    role: (conn as any).collabRole || "editor",
    uid: (conn as any).collabIdentity?.uid,
    name: (conn as any).collabIdentity?.name,
    epoch: (conn as any).collabEpoch ?? 0,
    inviteId: (conn as any).collabInviteId || undefined,
    conns: doc.conns.size,
    clients: doc.awareness.getStates().size,
    textLen: fileTextLen(doc),
    stateBytes: stateBytes(doc),
    mux: !!(conn as any).collabMux,
  });
  void auditEvent("ws.join", {
    room: roomName,
    ...roomInfo(roomName),
    connId: (conn as any).collabConnId,
    role: (conn as any).collabRole || "editor",
    uid: (conn as any).collabIdentity?.uid,
    name: (conn as any).collabIdentity?.name,
    device: (conn as any).collabIdentity?.device,
    deviceId: (conn as any).collabIdentity?.deviceId,
    epoch: (conn as any).collabEpoch ?? 0,
    inviteId: (conn as any).collabInviteId || undefined,
    remote: req.socket.remoteAddress || "",
    conns: doc.conns.size,
    mux: !!(conn as any).collabMux,
  });

  const syncEncoder = encoding.createEncoder();
  encoding.writeVarUint(syncEncoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(syncEncoder, doc);
  send(conn, encoding.toUint8Array(syncEncoder), roomName);

  const awarenessStates = doc.awareness.getStates();
  if (awarenessStates.size > 0) {
    const awarenessEncoder = encoding.createEncoder();
    encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      awarenessEncoder,
      awarenessProtocol.encodeAwarenessUpdate(
        doc.awareness,
        Array.from(awarenessStates.keys())
      )
    );
    send(conn, encoding.toUint8Array(awarenessEncoder), roomName);
  }

  return doc;
}

export function closeRevokedConnections(shareId: string, minEpoch: number): number {
  let closed = 0;
  const seen = new Set<WebSocket>();
  const closeIfRevoked = (conn: WebSocket): void => {
    if (seen.has(conn)) return;
    const connShareId = (conn as any).collabShareId;
    const connEpoch = Number((conn as any).collabEpoch ?? 0);
    if (connShareId === shareId && connEpoch < minEpoch) {
      seen.add(conn);
      closed++;
      conn.close(4003, "Share access revoked");
    }
  };
  const prefix = `@${shareId}:`;
  for (const [roomName, doc] of docs) {
    if (!roomName.startsWith(prefix)) continue;
    for (const conn of doc.conns.keys()) closeIfRevoked(conn);
  }
  for (const conn of activeMuxConnections) closeIfRevoked(conn);
  if (closed > 0) logEvent("warn", "share.revoked_connections_closed", { shareId, minEpoch, closed });
  return closed;
}

export function closeInviteConnections(shareId: string, inviteId: string): number {
  let closed = 0;
  const seen = new Set<WebSocket>();
  const closeIfInvite = (conn: WebSocket): void => {
    if (seen.has(conn)) return;
    if ((conn as any).collabShareId === shareId && (conn as any).collabInviteId === inviteId) {
      seen.add(conn);
      closed++;
      conn.close(4003, "Invite access revoked");
    }
  };
  const prefix = `@${shareId}:`;
  for (const [roomName, doc] of docs) {
    if (!roomName.startsWith(prefix)) continue;
    for (const conn of doc.conns.keys()) closeIfInvite(conn);
  }
  for (const conn of activeMuxConnections) closeIfInvite(conn);
  if (closed > 0) logEvent("warn", "share.invite_connections_closed", { shareId, inviteId, closed });
  return closed;
}

async function muxConnectionStillAuthorized(conn: WebSocket): Promise<boolean> {
  const shareId = (conn as any).collabShareId;
  if (!shareId) return false;
  const epoch = Number((conn as any).collabEpoch ?? 0);
  const minEpoch = await getMinEpoch(shareId);
  if (epoch >= minEpoch) return true;
  incMetric("revocations");
  logEvent("warn", "mux.revoked_connection_rejected", {
    shareId,
    epoch,
    minEpoch,
    connId: (conn as any).collabConnId,
    uid: (conn as any).collabIdentity?.uid,
  });
  conn.close(4003, "Share access revoked");
  return false;
}

/**
 * Send a binary message to a WebSocket client.
 */
function send(conn: WebSocket, message: Uint8Array, roomName?: string): void {
  if (conn.readyState !== WebSocket.OPEN) return;
  let out = message;
  if ((conn as any).collabMux) {
    if (!roomName) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_MUX);
    encoding.writeVarString(encoder, roomName);
    encoding.writeVarUint8Array(encoder, message);
    out = encoding.toUint8Array(encoder);
  }
  // Backpressure: a slow/cellular peer that can't drain makes the server buffer
  // unbounded send data → OOM. Close it; it reconnects and re-syncs cleanly.
  if (conn.bufferedAmount > SEND_BUFFER_LIMIT) {
    backpressureClosedCount++;
    incMetric("backpressure_closed");
    logEvent("warn", "ws.backpressure_closed", {
      room: roomName,
      ...(roomName ? roomInfo(roomName) : {}),
      connId: (conn as any).collabConnId,
      bufferedAmount: conn.bufferedAmount,
      limit: SEND_BUFFER_LIMIT,
      mux: !!(conn as any).collabMux,
    });
    closeConn(conn);
    return;
  }
  try {
    conn.send(out, (err) => {
      if (err) {
        incMetric("send_failures");
        logEvent("error", "ws.send_failed", {
          room: roomName,
          ...(roomName ? roomInfo(roomName) : {}),
          connId: (conn as any).collabConnId,
          bytes: out.byteLength,
          mux: !!(conn as any).collabMux,
          error: err,
        });
        closeConn(conn);
      }
    });
  } catch (e) {
    incMetric("send_failures");
    logEvent("error", "ws.send_threw", {
      room: roomName,
      ...(roomName ? roomInfo(roomName) : {}),
      connId: (conn as any).collabConnId,
      bytes: out.byteLength,
      mux: !!(conn as any).collabMux,
      error: e,
    });
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
        const subtype = decoding.readVarUint(decoding.clone(decoder));
        const beforeTextLen = fileTextLen(doc);
        const beforeStateBytes = SYNC_DEBUG_LOG ? stateBytes(doc) : null;
        // Permission boundary: non-editors may READ (sync step1 = sub-type 0)
        // but their WRITES (step2 = 1, update = 2) are dropped here — un-applied
        // and un-persisted, since doc.on('update') is the only fan-out. This is
        // the real read-only enforcement (the client UI is just cosmetic).
        const role = (conn as any).collabRole || "editor";
        if (role !== "editor") {
          if (subtype === 1 || subtype === 2) {
            const allowedCommentWrite =
              role === "commenter" &&
              commenterWritePreservesText(doc, decoding.clone(decoder));
            if (!allowedCommentWrite) {
              incMetric("rejected_writes");
              logEvent("warn", "sync.write_rejected", {
                room: doc.name,
                ...roomInfo(doc.name),
                connId: (conn as any).collabConnId,
                role,
                subtype: syncSubtypeName(subtype),
                messageBytes: message.byteLength,
                uid: (conn as any).collabIdentity?.uid,
                mux: !!(conn as any).collabMux,
              });
              return; // viewer write or commenter text write — ignore
            }
          }
        }
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(decoder, encoder, doc, conn);
        recordSyncMessage(doc, conn, subtype, message.byteLength, beforeTextLen, beforeStateBytes);
        if (encoding.length(encoder) > 1) {
          send(conn, encoding.toUint8Array(encoder), doc.name);
        }
        break;
      }
      case MESSAGE_AWARENESS: {
        const rawUpdate = decoding.readVarUint8Array(decoder);
        const filtered = filterAndStampAwarenessUpdate(doc, conn, rawUpdate);
        if (!filtered) return;
        awarenessProtocol.applyAwarenessUpdate(doc.awareness, filtered.update, conn);
        const controlled = doc.conns.get(conn);
        if (controlled) {
          for (const entry of filtered.entries) {
            if (entry.state === null) controlled.delete(entry.clientId);
            else controlled.add(entry.clientId);
          }
        }
        if (SYNC_DEBUG_LOG) {
          logEvent("debug", "awareness.update", {
            room: doc.name,
            ...roomInfo(doc.name),
            connId: (conn as any).collabConnId,
            entries: filtered.entries.length,
            rawBytes: rawUpdate.byteLength,
            clients: doc.awareness.getStates().size,
            controlled: controlled?.size ?? 0,
          });
        }
        break;
      }
      case MESSAGE_NOTIFY: {
        // Mention push, scoped to the SENDER's authed share. Viewers can't send.
        if (((conn as any).collabRole || "editor") === "viewer") return;
        try {
          const identity = (conn as any).collabIdentity as CollabIdentity;
          const shareId = (conn as any).collabShareId ?? null;
          const payload = JSON.parse(decoding.readVarString(decoder));
          void handleNotify(shareId, {
            ...payload,
            fromUid: identity.uid,
            fromName: identity.name,
          }, Date.now()).catch((e) => {
            logEvent("error", "notify.failed", {
              shareId,
              connId: (conn as any).collabConnId,
              uid: identity.uid,
              error: e,
            });
          });
        } catch { /* ignore */ }
        break;
      }
      case MESSAGE_TOPIC_REGISTER: {
        // Register the caller's own ntfy topic, scoped to its authed share.
        try {
          const p = JSON.parse(decoding.readVarString(decoder));
          const identity = (conn as any).collabIdentity as CollabIdentity;
          const shareId = (conn as any).collabShareId ?? null;
          void registerTopic(shareId, identity.uid, p.topic).catch((e) => {
            logEvent("error", "topic.register_failed", {
              shareId,
              connId: (conn as any).collabConnId,
              uid: identity.uid,
              error: e,
            });
          });
        } catch { /* ignore */ }
        break;
      }
      default:
        logEvent("warn", "ws.unknown_message_type", {
          room: doc.name,
          ...roomInfo(doc.name),
          connId: (conn as any).collabConnId,
          messageType,
          messageBytes: message.byteLength,
          mux: !!(conn as any).collabMux,
        });
    }
  } catch (e) {
    logEvent("error", "ws.message_failed", {
      room: doc.name,
      ...roomInfo(doc.name),
      connId: (conn as any).collabConnId,
      messageBytes: message.byteLength,
      mux: !!(conn as any).collabMux,
      error: e,
    });
  }
}

function recordSyncMessage(
  doc: WSSharedDoc,
  conn: WebSocket,
  subtype: number,
  messageBytes: number,
  beforeTextLen: number | null,
  beforeStateBytes: number | null
): void {
  if (subtype !== 1 && subtype !== 2) return;

  const afterTextLen = fileTextLen(doc);
  doc.stats.inboundSyncMessages++;
  doc.stats.inboundBytes += messageBytes;
  doc.stats.maxInboundBytes = Math.max(doc.stats.maxInboundBytes, messageBytes);
  doc.stats.lastUpdateAt = Date.now();
  if (afterTextLen !== null) {
    doc.stats.textLen = afterTextLen;
    doc.stats.maxTextLen = Math.max(doc.stats.maxTextLen ?? 0, afterTextLen);
  }

  const textDelta =
    beforeTextLen !== null && afterTextLen !== null
      ? afterTextLen - beforeTextLen
      : null;
  const largeTextDelta = textDelta !== null && Math.abs(textDelta) >= LARGE_TEXT_DELTA;
  const doubledText =
    beforeTextLen !== null &&
    afterTextLen !== null &&
    beforeTextLen > 1000 &&
    afterTextLen >= beforeTextLen * 1.8;
  const largeUpdate = messageBytes >= LARGE_UPDATE_BYTES;
  const shouldLog = SYNC_DEBUG_LOG || largeUpdate || largeTextDelta || doubledText;
  if (!shouldLog) return;

  if (largeUpdate || largeTextDelta || doubledText) doc.stats.suspiciousUpdates++;
  const info = roomInfo(doc.name);
  logEvent(largeUpdate || largeTextDelta || doubledText ? "warn" : "debug", "sync.update", {
    room: doc.name,
    ...info,
    connId: (conn as any).collabConnId,
    role: (conn as any).collabRole || "editor",
    subtype: syncSubtypeName(subtype),
    messageBytes,
    beforeTextLen,
    afterTextLen,
    textDelta,
    beforeStateBytes,
    afterStateBytes: SYNC_DEBUG_LOG || largeUpdate || doubledText ? stateBytes(doc) : undefined,
    largeUpdate,
    largeTextDelta,
    doubledText,
    conns: doc.conns.size,
  });
}

function commenterWritePreservesText(doc: WSSharedDoc, decoder: decoding.Decoder): boolean {
  if (roomInfo(doc.name).kind !== "file") return false;
  const beforeText = doc.getText("codemirror").toString();
  const testDoc = new Y.Doc({ gc: true });
  try {
    Y.applyUpdate(testDoc, Y.encodeStateAsUpdate(doc), "load");
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.readSyncMessage(decoder, encoder, testDoc, "commenter-check");
    return testDoc.getText("codemirror").toString() === beforeText;
  } catch {
    return false;
  } finally {
    testDoc.destroy();
  }
}

export function commenterSyncMessagePreservesTextForTest(
  roomName: string,
  baseState: Uint8Array,
  message: Uint8Array
): boolean {
  const doc = new WSSharedDoc(roomName);
  try {
    Y.applyUpdate(doc, baseState, "load");
    const decoder = decoding.createDecoder(message);
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return false;
    const subtype = decoding.readVarUint(decoding.clone(decoder));
    if (subtype !== 1 && subtype !== 2) return true;
    return commenterWritePreservesText(doc, decoder);
  } finally {
    doc.destroy();
  }
}

export function roomBlockedReasonForTest(roomName: string): string | null {
  return blockedRoomReason(roomName);
}

/**
 * Close a connection and clean up.
 */
function leaveRoom(conn: WebSocket, roomName: string, reason: string): boolean {
  const doc = docs.get(roomName);
  if (!doc) {
    forgetConnRoom(conn, roomName);
    return false;
  }
  const controlledIds = doc.conns.get(conn);
  if (!controlledIds) {
    forgetConnRoom(conn, roomName);
    return false;
  }

  doc.conns.delete(conn);
  forgetConnRoom(conn, roomName);
  incMetric("disconnects");

  awarenessProtocol.removeAwarenessStates(
    doc.awareness,
    Array.from(controlledIds),
    null
  );

  logEvent("info", "room.disconnect", {
    room: roomName,
    ...roomInfo(roomName),
    connId: (conn as any).collabConnId,
    conns: doc.conns.size,
    reason,
  });
  void auditEvent("ws.leave", {
    room: roomName,
    ...roomInfo(roomName),
    connId: (conn as any).collabConnId,
    role: (conn as any).collabRole || "editor",
    uid: (conn as any).collabIdentity?.uid,
    name: (conn as any).collabIdentity?.name,
    device: (conn as any).collabIdentity?.device,
    deviceId: (conn as any).collabIdentity?.deviceId,
    conns: doc.conns.size,
    reason,
  });

  closeRoomIfIdle(roomName, doc);
  return true;
}

function closeConn(conn: WebSocket): void {
  let closedAny = false;
  for (const roomName of takeConnRooms(conn)) {
    const doc = docs.get(roomName);
    if (!doc) continue;
    const controlledIds = doc.conns.get(conn);
    if (!controlledIds) continue;
    closedAny = true;

    doc.conns.delete(conn);
    incMetric("disconnects");

    // Remove awareness states for this client
    awarenessProtocol.removeAwarenessStates(
      doc.awareness,
      Array.from(controlledIds),
      null
    );

    logEvent("info", "room.disconnect", {
      room: roomName,
      ...roomInfo(roomName),
      connId: (conn as any).collabConnId,
      conns: doc.conns.size,
    });
    void auditEvent("ws.leave", {
      room: roomName,
      ...roomInfo(roomName),
      connId: (conn as any).collabConnId,
      role: (conn as any).collabRole || "editor",
      uid: (conn as any).collabIdentity?.uid,
      name: (conn as any).collabIdentity?.name,
      device: (conn as any).collabIdentity?.device,
      deviceId: (conn as any).collabIdentity?.deviceId,
      conns: doc.conns.size,
    });

    // If no clients remain, persist and clean up
    closeRoomIfIdle(roomName, doc);
  }

  if (closedAny) {
    try {
      conn.close();
    } catch (e) {
      // Already closed
    }
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
    logEvent("warn", "ws.bad_request", { reason: "missing-room", remote: req.socket.remoteAddress || "" });
    void auditEvent("ws.bad_request", { reason: "missing-room", remote: req.socket.remoteAddress || "" });
    conn.close(4000, "No room name");
    return;
  }

  const doc = await joinRoom(conn, req, roomName, url);
  if (!doc) return;

  // Handle incoming messages
  conn.on("message", (data: RawData) => {
    // Close instead of dropping a protocol frame; a reconnect resyncs cleanly.
    if (!allowMessage(conn)) {
      closeRateLimitedConnection(conn, "ws.rate_limited", {
        room: roomName,
        ...roomInfo(roomName),
        connId: (conn as any).collabConnId,
      });
      return;
    }
    const message = rawDataToUint8Array(data);
    handleMessage(conn, doc, message);
  });

  // Handle disconnect
  conn.on("close", () => {
    closeConn(conn);
  });

  conn.on("error", (err) => {
    logEvent("error", "ws.connection_error", {
      room: roomName,
      ...roomInfo(roomName),
      connId: (conn as any).collabConnId,
      error: err,
    });
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
}

export async function setupMuxConnection(
  conn: WebSocket,
  req: IncomingMessage
): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  (conn as any).collabMux = true;
  ensureConnectionIdentity(conn, req, url);
  activeMuxConnections.add(conn);

  logEvent("info", "mux.connect", {
    connId: (conn as any).collabConnId,
    shareId: (conn as any).collabShareId || undefined,
    role: (conn as any).collabRole || "editor",
    uid: (conn as any).collabIdentity?.uid,
  });
  void auditEvent("mux.join", {
    connId: (conn as any).collabConnId,
    shareId: (conn as any).collabShareId || undefined,
    role: (conn as any).collabRole || "editor",
    uid: (conn as any).collabIdentity?.uid,
    name: (conn as any).collabIdentity?.name,
    remote: req.socket.remoteAddress || "",
  });

  conn.on("message", (data: RawData) => {
    if (!allowMessage(conn)) {
      closeRateLimitedConnection(conn, "mux.rate_limited", {
        connId: (conn as any).collabConnId,
        shareId: (conn as any).collabShareId || undefined,
      });
      return;
    }
    void (async () => {
      try {
        if (!(await muxConnectionStillAuthorized(conn))) return;
        const message = rawDataToUint8Array(data);
        const decoder = decoding.createDecoder(message);
        const outerType = decoding.readVarUint(decoder);
        if (outerType === MESSAGE_MUX_LEAVE) {
          const roomName = decoding.readVarString(decoder);
          if (!muxRoomAllowed(conn, roomName)) {
            incMetric("mux_room_rejections");
            logEvent("warn", "mux.room_rejected", {
              room: roomName,
              ...roomInfo(roomName),
              shareId: (conn as any).collabShareId || undefined,
              connId: (conn as any).collabConnId,
              reason: "leave-share-mismatch",
            });
            conn.close(4403, "Room not in share");
            return;
          }
          leaveRoom(conn, roomName, "mux-leave");
          return;
        }
        if (outerType !== MESSAGE_MUX) {
          logEvent("warn", "mux.unknown_outer_message_type", {
            connId: (conn as any).collabConnId,
            shareId: (conn as any).collabShareId || undefined,
            outerType,
            messageBytes: message.byteLength,
          });
          return;
        }
        const roomName = decoding.readVarString(decoder);
        if (!muxRoomAllowed(conn, roomName)) {
          incMetric("mux_room_rejections");
          logEvent("warn", "mux.room_rejected", {
            room: roomName,
            ...roomInfo(roomName),
            shareId: (conn as any).collabShareId || undefined,
            connId: (conn as any).collabConnId,
            reason: "share-mismatch",
          });
          void auditEvent("mux.room.rejected", {
            room: roomName,
            shareId: (conn as any).collabShareId || undefined,
            connId: (conn as any).collabConnId,
            reason: "share-mismatch",
          });
          conn.close(4403, "Room not in share");
          return;
        }
        const inner = decoding.readVarUint8Array(decoder);
        const doc = await joinRoom(conn, req, roomName, url);
        if (!doc) return;
        handleMessage(conn, doc, inner);
      } catch (e) {
        logEvent("error", "mux.message_failed", {
          connId: (conn as any).collabConnId,
          shareId: (conn as any).collabShareId || undefined,
          error: e,
        });
      }
    })();
  });

  conn.on("close", () => {
    activeMuxConnections.delete(conn);
    closeConn(conn);
  });

  conn.on("error", (err) => {
    logEvent("error", "mux.connection_error", {
      connId: (conn as any).collabConnId,
      shareId: (conn as any).collabShareId || undefined,
      error: err,
    });
    closeConn(conn);
  });

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
}
