import { WebsocketProvider } from "y-websocket";
import { Platform } from "obsidian";
import * as Y from "yjs";
import type { ConnectionStatus } from "../types";
import { MuxProvider } from "./MuxProvider";
import { deviceColor } from "./PresenceModel";
import { trace } from "../utils/log";

export function detectDevice(): string {
  if (Platform.isMobile) return "mobile";
  return "desktop";
}

export function cursorDisplayName(name: string, device: string): string {
  const base = name?.trim() || "Anonymous";
  return device ? `${base} (${device})` : base;
}

const DEVICE_ID_KEY = "obsidian-collab-device-id";
let cachedDeviceId: string | null = null;

export function installDeviceId(): string {
  if (cachedDeviceId) return cachedDeviceId;
  try {
    const existing = globalThis.localStorage?.getItem(DEVICE_ID_KEY);
    if (existing) {
      cachedDeviceId = existing;
      return existing;
    }
  } catch {
    // localStorage can be unavailable in tests/sandboxed contexts.
  }

  const id =
    (globalThis.crypto?.randomUUID?.() as string | undefined) ||
    `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  try {
    globalThis.localStorage?.setItem(DEVICE_ID_KEY, id);
  } catch {
    // Best effort; keep the in-memory id for this session.
  }
  cachedDeviceId = id;
  return id;
}

export function deviceScopedColor(baseColor: string, deviceId = installDeviceId()): string {
  return deviceColor(baseColor || "#888888", deviceId);
}

export function localAwarenessUser(userInfo: { uid: string; name: string; color: string }): Record<string, string> {
  const device = detectDevice();
  const deviceId = installDeviceId();
  const displayName = userInfo.name?.trim() || "Anonymous";
  const cursorName = cursorDisplayName(displayName, device);
  const baseColor = userInfo.color || "#888888";
  const scopedColor = deviceScopedColor(baseColor, deviceId);
  return {
    uid: userInfo.uid,
    deviceId,
    name: cursorName,
    displayName,
    color: scopedColor,
    colorLight: scopedColor + "33",
    baseColor,
    device,
  };
}

export interface ProviderCallbacks {
  onStatus: (status: ConnectionStatus) => void;
  onSynced: (synced: boolean) => void;
  onError?: (error: unknown) => void;
}

function shareIdFromRoom(roomName: string): string | null {
  if (!roomName.startsWith("@")) return null;
  const idx = roomName.indexOf(":");
  return idx > 1 ? roomName.slice(1, idx) : null;
}

/**
 * Creates a configured WebsocketProvider with auth and awareness.
 */
export function createProvider(
  serverUrl: string,
  roomName: string,
  ydoc: Y.Doc,
  token: string,
  userInfo: { uid: string; name: string; color: string; identityPublicKey?: string; identitySignature?: string },
  callbacks: ProviderCallbacks,
  authParams: Record<string, string> = {}
): WebsocketProvider | MuxProvider {
  const device = detectDevice();
  const deviceId = installDeviceId();
  const displayName = userInfo.name?.trim() || "Anonymous";
  const cursorName = cursorDisplayName(displayName, device);
  const baseColor = userInfo.color || "#888888";
  const scopedColor = deviceScopedColor(baseColor, deviceId);
  const params: Record<string, string> = {
    token,
    uid: userInfo.uid,
    name: cursorName,
    color: scopedColor,
    baseColor,
    device,
    deviceId,
    ...(userInfo.identityPublicKey && userInfo.identitySignature
      ? { identityKey: userInfo.identityPublicKey, identitySig: userInfo.identitySignature }
      : {}),
    ...authParams,
  };
  const useMux = params.__mux === "true";
  delete params.__mux;
  const shareId = shareIdFromRoom(roomName);
  const provider = useMux && shareId
    ? new MuxProvider({ serverUrl, shareId, roomName, ydoc, params })
    : new WebsocketProvider(serverUrl, roomName, ydoc, {
      params,
      connect: true,
      // WebsocketProvider handles reconnection automatically
      maxBackoffTime: 10000,
    });

  // Set local awareness state so others can see our cursor. `uid` is the stable
  // join key across the separate manifest/file awarenesses (different clientIDs).
  provider.awareness.setLocalStateField("user", localAwarenessUser(userInfo));
  const localAwareness = provider.awareness.getLocalState?.();
  trace("awareness", "provider-user-state", {
    room: roomName,
    useMux,
    hasLocalState: !!localAwareness,
    hasUser: !!localAwareness?.user,
    clientId: provider.awareness.clientID,
  });

  // Forward status events
  provider.on("status", (event: { status: string }) => {
    switch (event.status) {
      case "connecting":
        callbacks.onStatus("connecting");
        break;
      case "connected":
        callbacks.onStatus("connected");
        break;
      case "disconnected":
        callbacks.onStatus("disconnected");
        break;
      default:
        break;
    }
  });

  // Forward sync events
  provider.on("sync", (synced: boolean) => {
    callbacks.onSynced(synced);
  });

  // Handle connection errors
  provider.on("connection-error", (error: unknown) => {
    callbacks.onStatus("error");
    callbacks.onError?.(error);
  });

  return provider;
}
