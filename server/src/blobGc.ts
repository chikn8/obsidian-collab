import fs from "fs/promises";
import type { Dirent } from "fs";
import path from "path";
import * as Y from "yjs";
import { safeBlobHash, safeBlobShareId } from "./blobs.js";

const PERSIST_DIR = process.env.PERSIST_DIR || "./collab-data";
const BLOB_DIR = path.join(PERSIST_DIR, "blobs");
export const BLOB_GC_GRACE_MS = Number(process.env.BLOB_GC_GRACE_MS || 24 * 60 * 60 * 1000);
const BLOB_GC_INTERVAL_MS = Number(process.env.BLOB_GC_INTERVAL_MS || 0);

export interface BlobGcResult {
  dryRun: boolean;
  graceMs: number;
  referenced: number;
  scanned: number;
  deleted: number;
  retainedReferenced: number;
  retainedYoung: number;
  skippedInvalid: number;
  bytesDeleted: number;
  bytesScanned: number;
}

let blobGcTimer: ReturnType<typeof setInterval> | null = null;

function manifestShareId(roomName: string): string | null {
  if (roomName === "__manifest__") return "legacy";
  if (!roomName.startsWith("@")) return null;
  const idx = roomName.indexOf(":");
  if (idx <= 1) return null;
  return roomName.slice(idx + 1) === "__manifest__" ? roomName.slice(1, idx) : null;
}

async function collectReferencedBlobs(): Promise<Set<string>> {
  const referenced = new Set<string>();
  let entries: string[];
  try {
    entries = await fs.readdir(PERSIST_DIR);
  } catch (e: any) {
    if (e?.code === "ENOENT") return referenced;
    throw e;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".yjs")) continue;
    let roomName: string;
    try {
      roomName = decodeURIComponent(entry.slice(0, -4));
    } catch {
      continue;
    }
    const shareId = manifestShareId(roomName);
    if (!shareId || !safeBlobShareId(shareId)) continue;

    try {
      const data = await fs.readFile(path.join(PERSIST_DIR, entry));
      const doc = new Y.Doc();
      Y.applyUpdate(doc, new Uint8Array(data), "blob-gc");
      const files = doc.getMap<any>("files");
      files.forEach((value) => {
        const hash = typeof value?.blobHash === "string" ? value.blobHash.toLowerCase() : "";
        if (safeBlobHash(hash)) referenced.add(`${shareId}:${hash}`);
      });
      doc.destroy();
    } catch (e) {
      console.error(`[blob-gc] failed to read manifest ${entry}:`, e);
    }
  }

  return referenced;
}

async function removeEmptyDir(dir: string): Promise<void> {
  await fs.rmdir(dir).catch((e: any) => {
    if (e?.code !== "ENOENT" && e?.code !== "ENOTEMPTY") throw e;
  });
}

export async function sweepOrphanBlobs(options: { dryRun?: boolean; graceMs?: number } = {}): Promise<BlobGcResult> {
  const dryRun = options.dryRun ?? true;
  const graceMs = options.graceMs ?? BLOB_GC_GRACE_MS;
  const referenced = await collectReferencedBlobs();
  const now = Date.now();
  const result: BlobGcResult = {
    dryRun,
    graceMs,
    referenced: referenced.size,
    scanned: 0,
    deleted: 0,
    retainedReferenced: 0,
    retainedYoung: 0,
    skippedInvalid: 0,
    bytesDeleted: 0,
    bytesScanned: 0,
  };

  let shares: Dirent[];
  try {
    shares = await fs.readdir(BLOB_DIR, { withFileTypes: true });
  } catch (e: any) {
    if (e?.code === "ENOENT") return result;
    throw e;
  }

  for (const share of shares) {
    if (!share.isDirectory() || !safeBlobShareId(share.name)) {
      result.skippedInvalid++;
      continue;
    }
    const shareDir = path.join(BLOB_DIR, share.name);
    const prefixes = await fs.readdir(shareDir, { withFileTypes: true }).catch(() => []);
    for (const prefix of prefixes) {
      if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) {
        result.skippedInvalid++;
        continue;
      }
      const prefixDir = path.join(shareDir, prefix.name);
      const files = await fs.readdir(prefixDir, { withFileTypes: true }).catch(() => []);
      for (const file of files) {
        if (!file.isFile() || !safeBlobHash(file.name) || !file.name.startsWith(prefix.name)) {
          result.skippedInvalid++;
          continue;
        }
        const filePath = path.join(prefixDir, file.name);
        const stat = await fs.stat(filePath).catch(() => null);
        if (!stat) continue;
        result.scanned++;
        result.bytesScanned += stat.size;

        if (referenced.has(`${share.name}:${file.name}`)) {
          result.retainedReferenced++;
          continue;
        }
        if (now - stat.mtimeMs < graceMs) {
          result.retainedYoung++;
          continue;
        }
        if (!dryRun) {
          await fs.rm(filePath, { force: true });
          await removeEmptyDir(prefixDir);
          await removeEmptyDir(shareDir);
        }
        result.deleted++;
        result.bytesDeleted += stat.size;
      }
    }
  }

  return result;
}

export function startBlobGc(): void {
  if (blobGcTimer || BLOB_GC_INTERVAL_MS <= 0) return;
  blobGcTimer = setInterval(() => {
    sweepOrphanBlobs({ dryRun: false }).then((result) => {
      if (result.deleted > 0) console.log("[blob-gc] sweep deleted", result.deleted, "orphan blob(s)");
    }).catch((e) => {
      console.error("[blob-gc] sweep failed:", e);
    });
  }, BLOB_GC_INTERVAL_MS);
  console.log(`[blob-gc] scheduled every ${BLOB_GC_INTERVAL_MS}ms`);
}

export function stopBlobGc(): void {
  if (!blobGcTimer) return;
  clearInterval(blobGcTimer);
  blobGcTimer = null;
}
