import type { Share } from "../types";

export function cleanShareFolder(folder: string): string {
  return folder
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

export function shareFolderOverlaps(shares: Share[], folder: string, exceptId?: string): Share | null {
  const path = cleanShareFolder(folder);
  if (!path) return null;
  for (const share of shares) {
    if (exceptId && share.id === exceptId) continue;
    const existing = cleanShareFolder(share.localFolder);
    if (!existing) continue;
    if (path === existing || path.startsWith(existing + "/") || existing.startsWith(path + "/")) return share;
  }
  return null;
}
