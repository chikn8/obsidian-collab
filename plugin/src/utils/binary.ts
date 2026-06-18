export const SYNCABLE_BINARY_EXTENSIONS = [
  "avif", "bmp", "gif", "heic", "jpeg", "jpg", "png", "svg", "webp",
  "pdf",
  "aac", "flac", "m4a", "mp3", "ogg", "opus", "wav",
  "m4v", "mov", "mp4", "mpeg", "webm",
] as const;

export const MAX_SYNCABLE_BINARY_BYTES = 25 * 1024 * 1024;

export function binaryExtension(path: string): string {
  return path.split("/").pop()?.split(".").pop()?.toLowerCase() || "";
}

export function isSyncableBinaryPath(path: string): boolean {
  return (SYNCABLE_BINARY_EXTENSIONS as readonly string[]).includes(binaryExtension(path));
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function buffersEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return false;
  return true;
}

export function isLocalBinaryNewer(localMtime: number, remoteUpdatedAt: number, skewMs = 2000): boolean {
  return Number.isFinite(localMtime) && Number.isFinite(remoteUpdatedAt) && localMtime > remoteUpdatedAt + skewMs;
}
