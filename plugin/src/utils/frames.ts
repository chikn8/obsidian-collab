import * as encoding from "lib0/encoding";

/**
 * Custom out-of-band frames over the y-websocket connection. Types 0-3 are
 * reserved by y/y-websocket (sync, awareness, auth, queryAwareness); ours are >=4.
 * The server handles these in rooms.ts; it never echoes them back, and the
 * y-websocket client ignores unknown inbound types, so this is safe one-way.
 */
export const MSG_NOTIFY = 4;
export const MSG_TOPIC_REGISTER = 5;

/** Best-effort send of a JSON frame over a provider's socket (no-op if down). */
export function sendFrame(provider: any, type: number, payload: unknown): boolean {
  if (!provider || provider.wsconnected !== true || !provider.ws) return false;
  try {
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, type);
    encoding.writeVarString(e, JSON.stringify(payload));
    provider.ws.send(encoding.toUint8Array(e));
    return true;
  } catch {
    return false;
  }
}
