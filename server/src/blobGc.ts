import fs from "fs/promises";
import path from "path";
import * as Y from "yjs";
import { deleteStoredBlob, listStoredBlobs, safeBlobHash, safeBlobShareId } from "./blobs.js";

const PERSIST_DIR = process.env.PERSIST_DIR || "./collab-data";
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

  for await (const blob of listStoredBlobs()) {
    if (!safeBlobShareId(blob.shareId) || !safeBlobHash(blob.hash) || blob.hash.slice(0, 2).length !== 2) {
      result.skippedInvalid++;
      continue;
    }
    result.scanned++;
    result.bytesScanned += blob.size;

    if (referenced.has(`${blob.shareId}:${blob.hash}`)) {
      result.retainedReferenced++;
      continue;
    }
    if (now - blob.updatedAt < graceMs) {
      result.retainedYoung++;
      continue;
    }
    if (!dryRun) await deleteStoredBlob(blob.shareId, blob.hash);
    result.deleted++;
    result.bytesDeleted += blob.size;
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
