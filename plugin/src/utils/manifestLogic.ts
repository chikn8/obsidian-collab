/**
 * Pure manifest-reconciliation decisions, factored out of SyncManager so they
 * can be unit-tested headlessly (no Obsidian/Yjs/network).
 */
import type { ManifestEntry } from "../types";

/** Grace window (ms) for clock skew between the deleter's clock and our mtime. */
export const RESURRECT_GRACE_MS = 2000;
export const SYNCABLE_TEXT_EXTENSIONS = ["md"] as const;
export const BLOCKED_SYNC_SEGMENTS = ["node_modules", ".git"] as const;
export type TombstoneLocalDecision = "delete" | "resurrect" | "conflict-copy";
export type ConflictKind = "delete" | "binary-update";

export interface ConflictFile {
  relPath: string;
  originalPath: string;
  kind: ConflictKind;
  reason?: string;
  createdAt?: number;
  by?: string;
  sourceMutationId?: string;
  remoteUpdatedAt?: number;
  localModifiedAt?: number;
  remoteHash?: string;
  localHash?: string;
}

function mutationPart(value: string | undefined, fallback: string): string {
  const clean = (value || "").trim().replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80);
  return clean || fallback;
}

export function manifestMutationFields(args: {
  action: string;
  at: number;
  seq: number;
  displayName: string;
  uid?: string;
  deviceId: string;
  device?: string;
}): Partial<ManifestEntry> {
  const actor = mutationPart(args.uid || args.displayName, "anonymous");
  const device = mutationPart(args.deviceId, "device");
  const fields: Partial<ManifestEntry> = {
    lastModified: args.at,
    mutationId: `${actor}:${device}:${args.seq}:${args.at}`,
    mutationAction: args.action,
    mutationSeq: args.seq,
    mutationAt: args.at,
    mutationBy: args.displayName,
    mutationByUid: args.uid || "",
    mutationDeviceId: args.deviceId,
    mutationDevice: args.device || "",
  };
  return fields;
}

export function isSyncableTextPath(path: string): boolean {
  if (hasBlockedSyncSegment(path)) return false;
  const ext = path.split("/").pop()?.split(".").pop()?.toLowerCase() || "";
  return (SYNCABLE_TEXT_EXTENSIONS as readonly string[]).includes(ext);
}

export function isSyncablePath(path: string): boolean {
  return isSyncableTextPath(path);
}

export function blockedSyncSegment(path: string): string | null {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.find((part) => (BLOCKED_SYNC_SEGMENTS as readonly string[]).includes(part)) || null;
}

export function hasBlockedSyncSegment(path: string): boolean {
  return blockedSyncSegment(path) !== null;
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
  tombstoneDeviceId?: string;
  localDeviceId?: string;
  tombstoneUid?: string;
  localUid?: string;
  localEditAt?: number;
  localEditDeviceId?: string;
  localEditUid?: string;
}): TombstoneLocalDecision {
  if (args.renamedTo) return "delete";
  const hasTombstoneOrigin = !!args.tombstoneDeviceId || !!args.tombstoneUid;
  const hasLocalEditOrigin = !!args.localEditDeviceId || !!args.localEditUid;
  const sameDeviceTombstone =
    !!args.localDeviceId &&
    !!args.tombstoneDeviceId &&
    args.localDeviceId === args.tombstoneDeviceId &&
    (!args.localUid || !args.tombstoneUid || args.localUid === args.tombstoneUid);
  if (sameDeviceTombstone) return "delete";

  const localChangedAt = args.localEditAt || args.localMtime;
  const delta = localChangedAt - args.deletedAt;
  if (delta > RESURRECT_GRACE_MS) {
    return hasTombstoneOrigin || hasLocalEditOrigin ? "conflict-copy" : "resurrect";
  }
  if (Math.abs(delta) <= RESURRECT_GRACE_MS) return "conflict-copy";
  return "delete";
}

export function shouldResurrect(args: {
  localMtime: number;
  deletedAt: number;
  renamedTo?: string;
  tombstoneDeviceId?: string;
  localDeviceId?: string;
  tombstoneUid?: string;
  localUid?: string;
  localEditAt?: number;
  localEditDeviceId?: string;
  localEditUid?: string;
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

export function conflictFileFromManifest(relPath: string, entry: ManifestEntry | undefined): ConflictFile | null {
  if (!entry || entry.exists === false || !entry.conflictOf) return null;
  const kind: ConflictKind = entry.conflictKind === "delete" ? "delete" : "binary-update";
  return {
    relPath,
    originalPath: entry.conflictOf,
    kind,
    reason: entry.conflictReason,
    createdAt: entry.conflictCreatedAt,
    by: entry.conflictBy,
    sourceMutationId: entry.conflictSourceMutationId,
    remoteUpdatedAt: entry.conflictRemoteUpdatedAt,
    localModifiedAt: entry.conflictLocalModifiedAt,
    remoteHash: entry.conflictRemoteHash,
    localHash: entry.conflictLocalHash,
  };
}

/**
 * Rename side effects such as wikilink repair must be single-writer. Applying
 * the same text replacement concurrently from multiple clients duplicates the
 * inserted link under CRDT merge, so only the device that authored the manifest
 * rename should perform local side effects.
 */
export function shouldApplyRenameSideEffects(
  entry: ManifestEntry | undefined,
  localUid: string | undefined,
  localDeviceId: string | undefined
): boolean {
  if (!entry?.renamedFrom) return false;
  const byUid = entry.mutationByUid || "";
  const byDevice = entry.mutationDeviceId || "";
  if (!byUid && !byDevice) return false;
  if (byUid && byUid !== (localUid || "")) return false;
  if (byDevice && byDevice !== (localDeviceId || "")) return false;
  return true;
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
    mutationId,
    mutationAction,
    mutationSeq,
    mutationAt,
    mutationBy,
    mutationByUid,
    mutationDeviceId,
    mutationDevice,
    conflictOf,
    conflictKind,
    conflictReason,
    conflictCreatedAt,
    conflictBy,
    conflictSourceMutationId,
    conflictRemoteUpdatedAt,
    conflictLocalModifiedAt,
    conflictRemoteHash,
    conflictLocalHash,
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
  void mutationId;
  void mutationAction;
  void mutationSeq;
  void mutationAt;
  void mutationBy;
  void mutationByUid;
  void mutationDeviceId;
  void mutationDevice;
  void conflictOf;
  void conflictKind;
  void conflictReason;
  void conflictCreatedAt;
  void conflictBy;
  void conflictSourceMutationId;
  void conflictRemoteUpdatedAt;
  void conflictLocalModifiedAt;
  void conflictRemoteHash;
  void conflictLocalHash;

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
