import * as Y from "yjs";

export type CollabEventType =
  | "message"
  | "online"
  | "offline"
  | "open"
  | "edit"
  | "create"
  | "delete"
  | "rename"
  | "restore"
  | "resurrect"
  | "conflict"
  | "binary"
  | "system";

export interface CollabEvent {
  id: string;
  type: CollabEventType;
  at: number;
  shareId: string;
  actorUid: string;
  actorName: string;
  deviceId: string;
  device?: string;
  path?: string;
  oldPath?: string;
  newPath?: string;
  text?: string;
  count?: number;
  details?: Record<string, unknown>;
}

export interface CollabEventInput {
  id?: string;
  type: CollabEventType;
  at?: number;
  shareId: string;
  actorUid: string;
  actorName: string;
  deviceId: string;
  device?: string;
  path?: string;
  oldPath?: string;
  newPath?: string;
  text?: string;
  count?: number;
  details?: Record<string, unknown>;
}

const MAX_TEXT = 2000;
const MAX_PATH = 512;
const MAX_DETAIL_STRING = 256;

export function normalizeEvent(input: CollabEventInput): CollabEvent {
  const event: CollabEvent = {
    id: cleanString(input.id || randomId(), 120) || randomId(),
    type: input.type,
    at: finiteNumber(input.at) || Date.now(),
    shareId: cleanString(input.shareId, 160) || "unknown",
    actorUid: cleanString(input.actorUid, 160) || "unknown",
    actorName: cleanString(input.actorName, 120) || "Anonymous",
    deviceId: cleanString(input.deviceId, 160) || "unknown",
  };
  const device = cleanString(input.device, 40);
  const path = cleanString(input.path, MAX_PATH);
  const oldPath = cleanString(input.oldPath, MAX_PATH);
  const newPath = cleanString(input.newPath, MAX_PATH);
  const text = cleanString(input.text, MAX_TEXT);
  const count = finiteNumber(input.count);
  const details = cleanDetails(input.details);
  if (device) event.device = device;
  if (path) event.path = path;
  if (oldPath) event.oldPath = oldPath;
  if (newPath) event.newPath = newPath;
  if (text) event.text = text;
  if (count && count > 1) event.count = Math.floor(count);
  if (details && Object.keys(details).length > 0) event.details = details;
  return event;
}

export function appendEvent(events: Y.Array<CollabEvent>, input: CollabEventInput, maxEvents = 1000): CollabEvent {
  const event = normalizeEvent(input);
  events.doc?.transact(() => {
    events.push([event]);
    const overflow = events.length - maxEvents;
    if (overflow > 0) events.delete(0, overflow);
  }, "collab-event");
  return event;
}

export function listEvents(events: Y.Array<CollabEvent> | null, limit = 300): CollabEvent[] {
  if (!events) return [];
  const all = events.toArray().map((e) => normalizeEvent(e));
  return all.slice(Math.max(0, all.length - limit));
}

export function formatEvent(event: CollabEvent): string {
  const who = event.actorName || "Someone";
  const path = event.path || event.newPath || event.oldPath || "";
  switch (event.type) {
    case "message":
      return event.text || "";
    case "online":
      return `${who} came online`;
    case "offline":
      return `${who} went offline`;
    case "open":
      return path ? `${who} opened ${path}` : `${who} opened a synced note`;
    case "edit":
      return path ? `${who} edited ${path}${event.count && event.count > 1 ? ` ${event.count} times` : ""}` : `${who} edited a note`;
    case "create":
      return path ? `${who} created ${path}` : `${who} created a file`;
    case "delete":
      return path ? `${who} deleted ${path}` : `${who} deleted a file`;
    case "rename":
      return event.oldPath && event.newPath ? `${who} renamed ${event.oldPath} to ${event.newPath}` : `${who} renamed a file`;
    case "restore":
      return path ? `${who} restored ${path}` : `${who} restored a deleted file`;
    case "resurrect":
      return path ? `${who} kept ${path} after a delete race` : `${who} kept a file after a delete race`;
    case "conflict":
      return event.path && event.newPath ? `${who} kept a conflict copy of ${event.path} at ${event.newPath}` : `${who} created a conflict copy`;
    case "binary":
      return path ? `${who} updated attachment ${path}` : `${who} updated an attachment`;
    case "system":
      return event.text || "System event";
    default:
      return "";
  }
}

function randomId(): string {
  return (globalThis.crypto?.randomUUID?.() as string) ||
    `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function cleanString(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}...`;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function cleanDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details || typeof details !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details).slice(0, 20)) {
    if (/token|secret|password|key|auth|content|body|text/i.test(key)) continue;
    if (value == null || typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (typeof value === "string") out[key] = cleanString(value, MAX_DETAIL_STRING);
  }
  return out;
}
