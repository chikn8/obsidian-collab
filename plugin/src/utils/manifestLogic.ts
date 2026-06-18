/**
 * Pure manifest-reconciliation decisions, factored out of SyncManager so they
 * can be unit-tested headlessly (no Obsidian/Yjs/network).
 */
import type { ManifestEntry } from "../types";
import { isSyncableBinaryPath } from "./binary";

/** Grace window (ms) for clock skew between the deleter's clock and our mtime. */
export const RESURRECT_GRACE_MS = 2000;
export const SYNCABLE_TEXT_EXTENSIONS = ["md", "canvas"] as const;
export type TombstoneLocalDecision = "delete" | "resurrect" | "conflict-copy";

export function isSyncableTextPath(path: string): boolean {
  const ext = path.split("/").pop()?.split(".").pop()?.toLowerCase() || "";
  return (SYNCABLE_TEXT_EXTENSIONS as readonly string[]).includes(ext);
}

export function isSyncablePath(path: string): boolean {
  return isSyncableTextPath(path) || isSyncableBinaryPath(path);
}

/**
 * Delete-vs-edit reconciliation: when a remote tombstone arrives for a file we
 * still hold, decide whether to delete it, resurrect it, or preserve it as a
 * visible conflict copy before deleting the original.
 *
 * A rename (`renamedTo` set) never resurrects or conflict-copies: the content
 * moved to the new path, the old path is meant to disappear.
 */
export function tombstoneLocalDecision(args: {
  localMtime: number;
  deletedAt: number;
  renamedTo?: string;
}): TombstoneLocalDecision {
  if (args.renamedTo) return "delete";
  const delta = args.localMtime - args.deletedAt;
  if (delta > RESURRECT_GRACE_MS) return "resurrect";
  if (Math.abs(delta) <= RESURRECT_GRACE_MS) return "conflict-copy";
  return "delete";
}

export function shouldResurrect(args: {
  localMtime: number;
  deletedAt: number;
  renamedTo?: string;
}): boolean {
  return tombstoneLocalDecision(args) === "resurrect";
}

function normalizeVaultPath(input: string): string {
  const out: string[] = [];
  for (const segment of input.replace(/\/+/g, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return out.join("/");
}

/** Validate a remotely-controlled manifest key before it can touch the vault. */
export function safeRelPath(relPath: unknown, localFolder = "", opts?: { textOnly?: boolean }): string | null {
  if (typeof relPath !== "string" || relPath.length === 0) return null;
  if (relPath.startsWith("/") || relPath.includes("\\") || relPath.includes(":")) return null;
  if (/[\x00-\x1F\x7F]/.test(relPath)) return null;
  if (opts?.textOnly ? !isSyncableTextPath(relPath) : !isSyncablePath(relPath)) return null;

  const parts = relPath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;

  const normalizedRel = parts.join("/");
  const normalizedFolder = normalizeVaultPath(localFolder);
  if (normalizedFolder) {
    const full = normalizeVaultPath(`${normalizedFolder}/${normalizedRel}`);
    if (full !== `${normalizedFolder}/${normalizedRel}` || !full.startsWith(`${normalizedFolder}/`)) {
      return null;
    }
  }
  return normalizedRel;
}

/** Startup should only publish a local file when the manifest has no opinion yet.
 *  A tombstone is an opinion and must go through tombstone reconciliation first. */
export function shouldPublishLocalOnStartup(entry: ManifestEntry | undefined): boolean {
  return !entry;
}

/** Tombstones from normal deletes are recoverable. Rename-away tombstones are not
 *  shown in "Deleted files" because the content still exists at the new path. */
export function isRecoverableTombstone(entry: ManifestEntry | undefined): boolean {
  return !!entry && entry.exists === false && !entry.renamedTo;
}

/**
 * Convert a prior manifest entry into a clean live entry. This intentionally
 * strips stale delete/rename/restore metadata before the caller adds fresh
 * metadata, so a restored/recreated path cannot behave like an old tombstone.
 */
export function liveManifestEntry(
  previous: Partial<ManifestEntry> | undefined,
  relPath: string,
  fileId: string,
  displayName: string,
  extra: Partial<ManifestEntry> = {}
): ManifestEntry {
  const {
    deleted,
    deletedAt,
    deletedBy,
    renamedFrom,
    renamedTo,
    restoredBy,
    restoredAt,
    resurrectedBy,
    ...rest
  } = previous || {};

  void deleted;
  void deletedAt;
  void deletedBy;
  void renamedFrom;
  void renamedTo;
  void restoredBy;
  void restoredAt;
  void resurrectedBy;

  return {
    ...rest,
    fileId,
    path: relPath,
    exists: true,
    deleted: false,
    lastModified: Date.now(),
    createdBy: previous?.createdBy || displayName,
    ...extra,
  };
}
