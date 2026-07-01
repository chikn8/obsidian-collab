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
  /** Blobs kept because their share's manifest exists but could not be read. */
  retainedUnreadable: number;
  /** Blobs kept because no manifest file exists for their share (quarantined,
   *  fresh volume, deleted share — a deleter must not guess which). */
  retainedNoManifest: number;
  skippedInvalid: number;
  bytesDeleted: number;
  bytesScanned: number;
  /** True when the sweep aborted without deleting (PERSIST_DIR unreadable). */
  aborted: boolean;
}

let blobGcTimer: ReturnType<typeof setInterval> | null = null;

function manifestShareId(roomName: string): string | null {
  if (roomName === "__manifest__") return "legacy";
  if (!roomName.startsWith("@")) return null;
  const idx = roomName.indexOf(":");
  if (idx <= 1) return null;
  return roomName.slice(idx + 1) === "__manifest__" ? roomName.slice(1, idx) : null;
}

interface ReferenceScan {
  referenced: Set<string>;
  /** Shares whose manifest file was successfully read. Deleting is only ever
   *  allowed for these — any gap in the evidence must fail CLOSED, not open. */
  readableShares: Set<string>;
  /** Shares whose manifest exists but could not be read/parsed. */
  unreadableShares: Set<string>;
  /** PERSIST_DIR itself was unreadable (fresh volume / misconfig): no sweep. */
  aborted: boolean;
}

async function collectReferencedBlobs(): Promise<ReferenceScan> {
  const scan: ReferenceScan = {
    referenced: new Set(),
    readableShares: new Set(),
    unreadableShares: new Set(),
    aborted: false,
  };
  let entries: string[];
  try {
    entries = await fs.readdir(PERSIST_DIR);
  } catch (e: any) {
    // A missing/unreadable PERSIST_DIR is NOT "zero references" — with an S3
    // blob store and a fresh volume, treating it that way would mass-delete
    // every blob past the grace window. Abort the sweep instead.
    scan.aborted = true;
    if (e?.code !== "ENOENT") console.error(`[blob-gc] failed to list ${PERSIST_DIR}:`, e);
    return scan;
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
        if (safeBlobHash(hash)) scan.referenced.add(`${shareId}:${hash}`);
      });
      doc.destroy();
      scan.readableShares.add(shareId);
    } catch (e) {
      scan.unreadableShares.add(shareId);
      console.error(`[blob-gc] failed to read manifest ${entry}; retaining that share's blobs:`, e);
    }
  }

  return scan;
}

export async function sweepOrphanBlobs(options: { dryRun?: boolean; graceMs?: number } = {}): Promise<BlobGcResult> {
  const dryRun = options.dryRun ?? true;
  const graceMs = options.graceMs ?? BLOB_GC_GRACE_MS;
  const scan = await collectReferencedBlobs();
  const now = Date.now();
  const result: BlobGcResult = {
    dryRun,
    graceMs,
    referenced: scan.referenced.size,
    scanned: 0,
    deleted: 0,
    retainedReferenced: 0,
    retainedYoung: 0,
    retainedUnreadable: 0,
    retainedNoManifest: 0,
    skippedInvalid: 0,
    bytesDeleted: 0,
    bytesScanned: 0,
    aborted: scan.aborted,
  };
  if (scan.aborted) {
    console.error("[blob-gc] sweep aborted: reference source unavailable, nothing deleted");
    return result;
  }

  for await (const blob of listStoredBlobs()) {
    if (!safeBlobShareId(blob.shareId) || !safeBlobHash(blob.hash) || blob.hash.slice(0, 2).length !== 2) {
      result.skippedInvalid++;
      continue;
    }
    result.scanned++;
    result.bytesScanned += blob.size;

    if (scan.referenced.has(`${blob.shareId}:${blob.hash}`)) {
      result.retainedReferenced++;
      continue;
    }
    // Fail closed: only delete when we positively read this share's manifest
    // and it does not reference the blob. Unreadable or absent manifests
    // (quarantined file, fresh volume) must never be read as "unreferenced".
    if (scan.unreadableShares.has(blob.shareId)) {
      result.retainedUnreadable++;
      continue;
    }
    if (!scan.readableShares.has(blob.shareId)) {
      result.retainedNoManifest++;
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

  if (result.retainedUnreadable > 0 || result.retainedNoManifest > 0) {
    console.warn(
      `[blob-gc] retained ${result.retainedUnreadable} blob(s) behind unreadable manifests and ` +
      `${result.retainedNoManifest} with no manifest — clean up manually if those shares are gone for good`
    );
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
