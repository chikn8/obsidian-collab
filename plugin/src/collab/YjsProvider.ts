import { WebsocketProvider } from "y-websocket";
import { Platform } from "obsidian";
import * as Y from "yjs";
import type { ConnectionStatus } from "../types";
import { MuxProvider } from "./MuxProvider";

function detectDevice(): string {
  if (Platform.isMobile) return "mobile";
  return "desktop";
}

const DEVICE_ID_KEY = "obsidian-collab-device-id";
let cachedDeviceId: string | null = null;

function installDeviceId(): string {
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

export interface ProviderCallbacks {
  onStatus: (status: ConnectionStatus) => void;
  onSynced: (synced: boolean) => void;
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
  const params: Record<string, string> = {
    token,
    uid: userInfo.uid,
    name: userInfo.name,
    color: userInfo.color,
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
  provider.awareness.setLocalStateField("user", {
    uid: userInfo.uid,
    deviceId,
    name: userInfo.name,
    color: userInfo.color,
    colorLight: userInfo.color + "33", // 20% opacity version for selection
    device,
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
  provider.on("connection-error", () => {
    callbacks.onStatus("error");
  });

  return provider;
}
