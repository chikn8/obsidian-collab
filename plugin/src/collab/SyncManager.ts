import { App, TFile, TFolder, Notice, debounce } from "obsidian";
import * as Y from "yjs";
import { createProvider, detectDevice, installDeviceId } from "./YjsProvider";
import { FileProvider } from "./FileProvider";
import { EchoGuard, beginRemoteApply, endRemoteApply, isApplyingRemote } from "./EchoGuard";
import { manifestRoom, fileRoom, shareToken, shareAuthParams, httpBase } from "../utils/roomName";
import { sendFrame, MSG_NOTIFY, MSG_TOPIC_REGISTER } from "../utils/frames";
import { getBinary, putBinary } from "../utils/http";
import { binaryRemoteDecision, buffersEqual, isSyncableBinaryPath, MAX_SYNCABLE_BINARY_BYTES, sha256Hex } from "../utils/binary";
import { log, trace } from "../utils/log";
import { rewriteObsidianLinks } from "../utils/wikiLinks";
import {
  isRecoverableTombstone,
  isSyncablePath,
  isSyncableTextPath,
  liveManifestEntry,
  manifestMutationFields,
  safeRelPath,
  shouldPublishLocalOnStartup,
  tombstoneLocalDecision,
} from "../utils/manifestLogic";
import { colorFor, MANIFEST_SCHEMA_VERSION } from "../types";
import type { CollabPluginSettings, ConnectedUser, SyncStatus, Share, ManifestEntry } from "../types";
import {
  collectPresenceDevices,
  presenceKeyFromState,
  type PresenceDevice,
} from "./PresenceModel";
import {
  appendPresenceHost,
  clearRenderedPresence,
  findFileTreeTitle,
  tabHeaderForLeaf,
  tabPresenceTarget,
} from "./PresenceDom";

/** Stable file identity. crypto.randomUUID where available, else a random fallback. */
function newFileId(): string {
  return (globalThis.crypto?.randomUUID?.() as string) ||
    `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Syncs ONE share (one local folder ↔ one namespaced room set). The plugin
 * runs one SyncManager per share. Cursors/selections inside the open editor
 * are handled by yCollab (see EditorBinding); this class owns the folder
 * manifest, per-file providers, and the file-explorer presence avatars.
 */
export class SyncManager {
  private app: App;
  private settings: CollabPluginSettings;
  private share: Share;

  // Manifest
  private manifestDoc: Y.Doc | null = null;
  private manifestProvider: any = null;  // WebsocketProvider
  private manifestMap: Y.Map<any> | null = null;
  private manifestMeta: Y.Map<any> | null = null; // schemaVersion + future doc-level meta
  // Volatile "who last edited" stamps live in a SEPARATE map so they merge
  // independently of the files map's lifecycle (exists/deleted) field — a stamp
  // can never LWW-clobber a concurrent delete/rename tombstone.
  private editsMap: Y.Map<any> | null = null;
  // fileId we last saw per relPath, to detect identity changes (new file at same path).
  private fileIds: Map<string, string> = new Map();
  private manifestMutationSeq = 0;

  // File providers, keyed by relPath
  private fileProviders: Map<string, FileProvider> = new Map();

  // Guards. EchoGuard fingerprints every plugin-initiated vault write so the
  // resulting vault event is recognised as our own echo and dropped — no timing
  // windows (mobile / slow disk safe). See EchoGuard.ts.
  private echo = new EchoGuard();
  private processingManifest = false;

  // Status
  private syncStatus: SyncStatus = "disconnected";
  private onStatusChange: (status: SyncStatus, fileCount: number, pending: number) => void;
  private onUsersChange: (users: ConnectedUser[]) => void;

  // Presence indicators (file explorer) — full-path → rendered elements
  private renderedPresence: Map<string, HTMLElement[]> = new Map();
  private renderedTabPresence: Map<string, HTMLElement[]> = new Map();
  private lastPresenceSig = "";
  private linkRewriteRenames: Set<string> = new Set();
  private debouncedPresence: () => void;
  private debouncedStatus: () => void;

  constructor(
    app: App,
    settings: CollabPluginSettings,
    share: Share,
    onStatusChange: (status: SyncStatus, fileCount: number, pending: number) => void,
    onUsersChange: (users: ConnectedUser[]) => void
  ) {
    this.app = app;
    this.settings = settings;
    this.share = share;
    this.onStatusChange = onStatusChange;
    this.onUsersChange = onUsersChange;
    this.debouncedPresence = debounce(() => this.renderPresence(), 120, false);
    this.debouncedStatus = debounce(() => this.emitStatus(), 400, false);
  }

  get shareId(): string { return this.share.id; }

  /** Share id as used by the server snapshot/history paths ("legacy" for the legacy share). */
  get histShareId(): string { return this.share.legacy ? "legacy" : this.share.id; }

  /** Total local edits across this share's files made while offline (unsynced). */
  pendingOfflineCount(): number {
    let n = 0;
    for (const [, fp] of this.fileProviders) n += fp.pendingOffline();
    return n;
  }

  /** Emit the current status + offline-pending count to the status bar. */
  private emitStatus(): void {
    this.onStatusChange(this.syncStatus, this.fileProviders.size, this.pendingOfflineCount());
  }

  /** Effective color: explicit user choice, else a stable hash of uid. */
  private userColor(): string {
    return this.settings.cursorColor || colorFor(this.settings.uid || this.settings.displayName);
  }

  /** Manifest awareness — drives facepile / follow / typing (P1B). */
  getManifestAwareness(): any { return this.manifestProvider?.awareness ?? null; }

  /** Collaborators currently in this share (for @mention autocomplete). */
  roster(): { uid: string; name: string }[] {
    const aw = this.manifestProvider?.awareness;
    if (!aw) return [];
    const out: { uid: string; name: string }[] = [];
    const seen = new Set<string>();
    aw.getStates().forEach((s: any) => {
      const u = s?.user;
      if (u?.uid && u.uid !== this.settings.uid && !seen.has(u.uid)) {
        seen.add(u.uid);
        out.push({ uid: u.uid, name: u.displayName || u.name || "Anonymous" });
      }
    });
    return out;
  }

  // last-edited-by stamping (debounced per file to bound manifest churn). Written
  // to the SEPARATE `edits` map, never the files map, so it cannot LWW-clobber a
  // concurrent delete/rename tombstone (the bug a whole-object stamp would cause).
  private stampDebounce: Map<string, () => void> = new Map();
  private stampEdit(relPath: string): void {
    let fn = this.stampDebounce.get(relPath);
    if (!fn) {
      fn = debounce(() => {
        if (!this.editsMap) return;
        this.editsMap.set(relPath, { by: this.settings.displayName, at: Date.now() });
      }, 3000, false);
      this.stampDebounce.set(relPath, fn);
    }
    fn();
  }

  /** Force-reconnect every socket for this share (manifest + files). */
  reconnect(): boolean {
    let ok = true;
    const mp = this.manifestProvider;
    if (mp) {
      try {
        mp.wsUnsuccessfulReconnects = 0;
        mp.disconnect();
        mp.connect();
      } catch (e) {
        ok = false;
        trace("ws", "manifest-reconnect-failed", { shareId: this.histShareId, error: e });
      }
    }
    for (const [, fp] of this.fileProviders) {
      if (!fp.reconnect()) ok = false;
    }
    return ok;
  }

  /** Re-render presence UI after Obsidian changes tab/file-explorer layout. */
  refreshPresenceUi(): void {
    trace("presence", "refresh-requested", { shareId: this.histShareId, providers: this.fileProviders.size });
    this.lastPresenceSig = "";
    this.debouncedPresence();
  }

  /** Send an @mention push frame (server fans out to the target's ntfy topic). */
  sendMention(toUid: string, title: string, body: string, filePath?: string): void {
    sendFrame(this.manifestProvider, MSG_NOTIFY, {
      fromUid: this.settings.uid,
      fromName: this.settings.displayName,
      toUid,
      title,
      body,
      filePath,
    });
  }

  /** Iterate live file providers (for reconnect / presence). */
  eachFileProvider(fn: (relPath: string, fp: FileProvider) => void): void {
    for (const [rel, fp] of this.fileProviders) fn(rel, fp);
  }

  get role(): string { return this.share.role || "editor"; }
  get localFolder(): string { return this.share.localFolder; }
  toRel(fullPath: string): string { return this.toRelativePath(fullPath); }
  toFull(relPath: string): string { return this.toFullPath(relPath); }

  private manifestMutation(action: string): Partial<ManifestEntry> {
    return manifestMutationFields({
      action,
      at: Date.now(),
      seq: ++this.manifestMutationSeq,
      displayName: this.settings.displayName,
      uid: this.settings.uid,
      deviceId: installDeviceId(),
      device: detectDevice(),
    });
  }

  /** Start syncing the share's folder */
  async start(): Promise<void> {
    if (!this.share.localFolder || !this.settings.serverUrl) return;
    trace("share", "start", {
      shareId: this.share.legacy ? "legacy" : this.share.id,
      localFolder: this.share.localFolder,
      role: this.role,
      legacy: !!this.share.legacy,
    });

    this.syncStatus = "connecting";
    this.onStatusChange("connecting", 0, 0);

    // Connect to manifest room (namespaced per share)
    this.manifestDoc = new Y.Doc();
    this.manifestMap = this.manifestDoc.getMap("files");
    this.manifestMeta = this.manifestDoc.getMap("meta");
    this.editsMap = this.manifestDoc.getMap("edits");

    this.manifestProvider = createProvider(
      this.settings.serverUrl,
      manifestRoom(this.share),
      this.manifestDoc,
      shareToken(this.share, this.settings.serverPassword),
      {
        uid: this.settings.uid,
        name: this.settings.displayName,
        color: this.userColor(),
        identityPublicKey: this.settings.identityPublicKey,
        identitySignature: this.settings.identitySignature,
      },
      {
        onStatus: (status) => {
          trace("ws", "manifest-status", {
            shareId: this.share.legacy ? "legacy" : this.share.id,
            room: manifestRoom(this.share),
            status,
          });
          if (status === "connected") {
            this.syncStatus = "connected";
            // Register our ntfy topic so collaborators can @mention us (even offline).
            if (this.settings.ntfyTopic && this.settings.uid) {
              sendFrame(this.manifestProvider, MSG_TOPIC_REGISTER, { uid: this.settings.uid, topic: this.settings.ntfyTopic });
            }
          } else if (status === "error") {
            this.syncStatus = "error";
          }
          this.emitStatus();
        },
        onSynced: (synced) => {
          trace("ws", "manifest-synced", {
            shareId: this.share.legacy ? "legacy" : this.share.id,
            room: manifestRoom(this.share),
            synced,
          });
          if (synced) {
            this.onManifestSynced();
          }
        },
      },
      this.providerAuthParams()
    );

    // Observe manifest changes from remote
    this.manifestMap.observe((event) => {
      if (this.processingManifest) return;
      this.handleManifestChange(event);
    });

    // Awareness drives file-explorer presence avatars (debounced + diffed)
    this.manifestProvider.awareness.on("change", () => {
      this.debouncedPresence();
    });
  }

  /** Called after initial manifest sync -- reconcile local folder with manifest */
  private async onManifestSynced(): Promise<void> {
    this.processingManifest = true;
    trace("manifest", "startup-reconcile-start", {
      shareId: this.histShareId,
      role: this.role,
      entries: this.manifestMap?.size ?? 0,
    });

    // Schema v1 → v2 migration: backfill fileIds (idempotent; LWW-converges if
    // two clients migrate at once). Editors only — viewers can't write.
    if (this.role === "editor") this.migrateManifest();
    // Remember every entry's fileId so we can later detect a *different* file
    // appearing at the same path (concurrent same-path create).
    this.manifestMap!.forEach((entry: any, relPath: string) => {
      if (!this.safeManifestRelPath(relPath, "startup fileId cache")) return;
      if (entry?.fileId) this.fileIds.set(relPath, entry.fileId);
    });

    // Get all local synced text files in linked folder.
    const localFiles = this.getLocalFiles();

    // First reconcile tombstones for local files. This must run BEFORE publishing
    // local files, otherwise a remote delete would be flipped back to exists:true
    // and silently resurrected on every offline client's startup.
    if (this.role === "editor") {
      for (const filePath of localFiles) {
        const relPath = this.toRelativePath(filePath);
        if (!this.safeManifestRelPath(relPath, "startup local tombstone")) continue;
        const entry = this.manifestMap!.get(relPath) as ManifestEntry | undefined;
        if (entry && !entry.exists) {
          await this.applyRemoteTombstone(relPath, entry, false);
        }
      }
    }

    // Editors publish genuinely new local files. Viewers/commenters mirror remote
    // state only. A tombstone is not "missing"; it was handled above.
    if (this.role === "editor") {
      for (const filePath of localFiles) {
        if (!(this.app.vault.getAbstractFileByPath(filePath) instanceof TFile)) continue;
        const relPath = this.toRelativePath(filePath);
        if (!this.safeManifestRelPath(relPath, "startup local publish")) continue;
        const entry = this.manifestMap!.get(relPath) as ManifestEntry | undefined;
        if (shouldPublishLocalOnStartup(entry)) {
          if (isSyncableBinaryPath(relPath)) {
            await this.publishBinaryFile(relPath, filePath, undefined, "startup-create");
          } else {
            const fileId = newFileId();
            const mutation = this.manifestMutation("startup-create");
            this.fileIds.set(relPath, fileId);
            this.manifestMap!.set(relPath, liveManifestEntry(undefined, relPath, fileId, this.settings.displayName, {
              kind: "text",
              ...mutation,
            }));
          }
        } else if (entry?.exists && this.entryKind(relPath, entry) === "binary") {
          const file = this.app.vault.getAbstractFileByPath(filePath);
          const info = file instanceof TFile ? await this.readBinaryInfo(file) : null;
          if (info && (info.hash !== entry.blobHash || info.size !== entry.blobSize)) {
            const localMtime = file instanceof TFile ? file.stat.mtime : 0;
            const remoteUpdatedAt = entry.blobUpdatedAt || entry.lastModified || 0;
            const decision = binaryRemoteDecision(localMtime, remoteUpdatedAt);
            if (decision === "keep-local") {
              await this.publishBinaryFile(relPath, filePath, entry, "startup-offline");
            } else if (decision === "conflict-copy" && file instanceof TFile) {
              trace("blob", "startup-binary-conflict-deferred", {
                shareId: this.histShareId,
                relPath,
                localHash: info.hash,
                remoteHash: entry.blobHash,
                localMtime,
                remoteUpdatedAt,
              });
            }
          }
        }
      }
    }

    // Create local files for manifest entries that don't exist locally
    const manifestEntries = Array.from(this.manifestMap!.entries());
    for (const [relPath, entry] of manifestEntries) {
      const safeRel = this.safeManifestRelPath(relPath, "startup manifest create");
      if (!safeRel) continue;
      if (!entry.exists) continue;
      const fullPath = this.toFullPath(safeRel);
      if (this.entryKind(safeRel, entry) === "binary") {
        await this.applyRemoteBinary(safeRel, entry, "startup");
        continue;
      }
      const file = this.app.vault.getAbstractFileByPath(fullPath);
      if (!file) {
        // Ensure parent folders exist
        const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
        if (dir) {
          await this.ensureFolder(dir);
        }
        await this.guardedCreate(fullPath);
      }
    }

    this.processingManifest = false;

    // Create FileProviders for all existing files
    for (const [relPath, entry] of manifestEntries) {
      const safeRel = this.safeManifestRelPath(relPath, "startup provider");
      if (!safeRel) continue;
      if (!entry.exists) continue;
      if (this.entryKind(safeRel, entry) !== "text") continue;
      const fullPath = this.toFullPath(safeRel);
      if (!this.fileProviders.has(safeRel)) {
        await this.createFileProvider(safeRel, fullPath);
      }
    }

    for (const [relPath, entry] of manifestEntries) {
      const safeRel = this.safeManifestRelPath(relPath, "startup link rewrite");
      if (!safeRel || !entry.exists || !entry.renamedFrom) continue;
      await this.rewriteLinksForRemoteRename(entry.renamedFrom, safeRel, entry.fileId);
    }

    this.syncStatus = "connected";
    this.emitStatus();
    trace("manifest", "startup-reconcile-done", {
      shareId: this.histShareId,
      providers: this.fileProviders.size,
    });
  }

  /**
   * Idempotent schema v1→v2 migration: give every entry lacking one a stable
   * `fileId` and stamp the doc's schemaVersion. Additive — v1 clients keep
   * working and ignore the new fields. Concurrent migration on two clients just
   * assigns two ids and LWW-converges (fileId is an identity hint, not a key).
   */
  private migrateManifest(): void {
    if (!this.manifestMap || !this.manifestMeta) return;
    let changed = 0;
    this.manifestDoc!.transact(() => {
      this.manifestMap!.forEach((entry: any, relPath: string) => {
        if (!this.safeManifestRelPath(relPath, "manifest migration")) return;
        if (entry && !entry.fileId) {
          this.manifestMap!.set(relPath, { ...entry, fileId: newFileId(), path: relPath });
          changed++;
        }
      });
      const v = this.manifestMeta!.get("schemaVersion") || 1;
      if (v < MANIFEST_SCHEMA_VERSION) this.manifestMeta!.set("schemaVersion", MANIFEST_SCHEMA_VERSION);
    });
    if (changed) log("delete", "manifest migrated v2: assigned", changed, "fileId(s)");
  }

  /** Handle remote manifest changes */
  private async handleManifestChange(event: Y.YMapEvent<any>): Promise<void> {
    for (const [key, change] of event.changes.keys) {
      const relPath = this.safeManifestRelPath(key, "manifest change");
      if (!relPath) continue;
      const entry = this.manifestMap!.get(key) as ManifestEntry | undefined;
      if (!entry) continue;
      trace("manifest", "change", {
        shareId: this.histShareId,
        relPath,
        action: change.action,
        exists: entry.exists,
        fileId: entry.fileId,
        renamedTo: entry.renamedTo,
        deletedAt: entry.deletedAt,
        mutationId: entry.mutationId,
        mutationAction: entry.mutationAction,
        mutationAt: entry.mutationAt,
        mutationBy: entry.mutationBy,
        mutationByUid: entry.mutationByUid,
        mutationDeviceId: entry.mutationDeviceId,
      });

      const fullPath = this.toFullPath(relPath);

      if (entry.exists && change.action !== "delete") {
        if (this.entryKind(relPath, entry) === "binary") {
          if (entry.fileId) this.fileIds.set(relPath, entry.fileId);
          await this.applyRemoteBinary(relPath, entry);
          await this.rewriteLinksForRemoteRename(entry.renamedFrom, relPath, entry.fileId);
          continue;
        }

        // Identity check: a DIFFERENT file now occupies this path (concurrent
        // same-path create, or a path reused after deletion). Drop the stale
        // local doc so we adopt the new file's room cleanly instead of merging
        // two unrelated histories into one.
        const knownId = this.fileIds.get(relPath);
        if (entry.fileId && knownId && knownId !== entry.fileId) {
          const stale = this.fileProviders.get(relPath);
          if (stale) { await stale.destroyAndClearData(); this.fileProviders.delete(relPath); }
          log("delete", "fileId changed at", relPath, "- adopting new identity");
        }
        if (entry.fileId) this.fileIds.set(relPath, entry.fileId);

        // File should exist -- create locally if missing
        const file = this.app.vault.getAbstractFileByPath(fullPath);
        if (!file) {
          const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
          if (dir) await this.ensureFolder(dir);
          await this.guardedCreate(fullPath);
        }
        if (!this.fileProviders.has(relPath)) {
          await this.createFileProvider(relPath, fullPath);
        }
        await this.rewriteLinksForRemoteRename(entry.renamedFrom, relPath, entry.fileId);
      } else if (!entry.exists) {
        // File was deleted (or renamed-away) remotely.
        await this.applyRemoteTombstone(relPath, entry, true);
      }
    }
    this.emitStatus();
  }

  /**
   * Apply a tombstone to our local copy of `relPath`: resurrect if we edited it
   * after the delete (no silent loss), otherwise snapshot + trash + remove it.
   * Shared by the live `handleManifestChange` AND the startup `onManifestSynced`
   * reconcile so the boot path can't silently delete locally-edited files.
   * Returns true if the file was resurrected (kept).
   */
  private async applyRemoteTombstone(relPath: string, entry: ManifestEntry, notifyIfOpen: boolean): Promise<boolean> {
    const safeRel = this.safeManifestRelPath(relPath, "remote tombstone");
    if (!safeRel) return false;
    const fullPath = this.toFullPath(safeRel);
    const provider = this.fileProviders.get(safeRel);
    const file = this.app.vault.getAbstractFileByPath(fullPath);
    const deletedAt = entry.deletedAt || entry.lastModified || 0;
    const isBinary = this.entryKind(safeRel, entry) === "binary";

    // Delete-vs-edit handling. Renames carry `renamedTo` and must not resurrect:
    // the content moved to the new path. Ambiguous wall-clock skew gets a visible
    // conflict copy before the tombstone is applied, so local edits are not lost.
    const localDecision =
      this.role === "editor" && file instanceof TFile
        ? tombstoneLocalDecision({
          localMtime: file.stat.mtime,
          deletedAt,
          renamedTo: entry.renamedTo,
          localUid: this.settings.uid,
          localDeviceId: installDeviceId(),
          tombstoneUid: entry.mutationByUid,
          tombstoneDeviceId: entry.mutationDeviceId,
        })
        : "delete";
    if (
      file instanceof TFile &&
      localDecision === "resurrect"
    ) {
      trace("manifest", "tombstone-resurrect", {
        shareId: this.histShareId,
        relPath: safeRel,
        deletedAt,
        localMtime: file.stat.mtime,
        renamedTo: entry.renamedTo,
        mutationId: entry.mutationId,
        mutationByUid: entry.mutationByUid,
        mutationDeviceId: entry.mutationDeviceId,
      });
      const fileId = entry.fileId || this.fileIds.get(relPath) || newFileId();
      const mutation = this.manifestMutation("resurrect");
      this.fileIds.set(safeRel, fileId);
      this.manifestMap!.set(safeRel, liveManifestEntry(entry, safeRel, fileId, this.settings.displayName, {
        ...mutation,
        resurrectedBy: this.settings.displayName,
      }));
      new Notice(`"${safeRel}" was edited after being deleted — kept`);
      log("delete", "resurrected (edited after delete)", safeRel);
      return true;
    }

    if (file instanceof TFile && localDecision === "conflict-copy") {
      const conflictRel = await this.createDeleteConflictCopy(safeRel, file, provider, isBinary);
      trace("manifest", "tombstone-conflict-copy", {
        shareId: this.histShareId,
        relPath: safeRel,
        conflictRel,
        deletedAt,
        localMtime: file.stat.mtime,
        mutationId: entry.mutationId,
        mutationByUid: entry.mutationByUid,
        mutationDeviceId: entry.mutationDeviceId,
      });
      if (conflictRel) {
        new Notice(`"${safeRel}" changed near a remote delete — kept a conflict copy at "${conflictRel}"`);
      }
    }

    if (file instanceof TFile) {
      trace("manifest", "tombstone-apply", {
        shareId: this.histShareId,
        relPath: safeRel,
        deletedAt,
        renamedTo: entry.renamedTo,
        hasProvider: !!provider,
      });
      if (notifyIfOpen) {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile && activeFile.path === fullPath && !entry.renamedTo) {
          new Notice(`"${safeRel}" was deleted by ${entry.deletedBy || "collaborator"}`);
        }
      }
      // Keep a local recovery copy before removing our copy too.
      if (provider) {
        await provider.flushSnapshot();
        await provider.saveToTrash();
      } else if (!isBinary) {
        const content = await this.app.vault.read(file).catch(() => "");
        if (content.length > 0) {
          await FileProvider.saveTextSnapshot(this.app, fullPath, content).catch((e) => log("delete", "startup snapshot failed", fullPath, e));
          await FileProvider.saveTextToTrash(this.app, this.histShareId, fullPath, content).catch((e) => log("delete", "startup trash failed", fullPath, e));
        }
      }
      await this.guardedDelete(file);
    }
    // Destroy provider and clear persisted data
    if (provider) {
      await provider.destroyAndClearData();
      this.fileProviders.delete(safeRel);
    }
    this.fileIds.delete(safeRel);
    return false;
  }

  private async createDeleteConflictCopy(
    safeRel: string,
    file: TFile,
    provider: FileProvider | undefined,
    isBinary: boolean
  ): Promise<string | null> {
    const conflictRel = this.nextDeleteConflictRelPath(safeRel);
    if (!conflictRel) return null;

    const conflictFullPath = this.toFullPath(conflictRel);
    const dir = conflictFullPath.substring(0, conflictFullPath.lastIndexOf("/"));
    if (dir) await this.ensureFolder(dir);

    try {
      if (isBinary) {
        const data = await this.app.vault.readBinary(file);
        await this.app.vault.createBinary(conflictFullPath, data);
        await this.publishBinaryFile(conflictRel, conflictFullPath, undefined, "delete-conflict");
      } else {
        const content = provider ? provider.getText() : await this.app.vault.read(file);
        await this.app.vault.create(conflictFullPath, content);
        const fileId = newFileId();
        const mutation = this.manifestMutation("delete-conflict-copy");
        this.fileIds.set(conflictRel, fileId);
        this.manifestMap?.set(conflictRel, liveManifestEntry(undefined, conflictRel, fileId, this.settings.displayName, {
          ...mutation,
          resurrectedBy: this.settings.displayName,
        }));
        await this.createFileProvider(conflictRel, conflictFullPath);
      }
      log("delete", "created delete conflict copy", safeRel, "->", conflictRel);
      return conflictRel;
    } catch (e) {
      trace("manifest", "tombstone-conflict-copy-failed", {
        shareId: this.histShareId,
        relPath: safeRel,
        conflictRel,
        error: e,
      });
      log("delete", "delete conflict copy failed", safeRel, e);
      return null;
    }
  }

  private nextDeleteConflictRelPath(safeRel: string): string | null {
    return this.nextConflictRelPath(safeRel, "delete conflict", "delete conflict copy");
  }

  private async createBinaryConflictCopy(
    safeRel: string,
    file: TFile,
    data: ArrayBuffer,
    remoteEntry: ManifestEntry | undefined,
    reason: "startup" | "live"
  ): Promise<string | null> {
    const conflictRel = this.nextConflictRelPath(safeRel, "binary conflict", "binary conflict copy");
    if (!conflictRel) return null;

    const conflictFullPath = this.toFullPath(conflictRel);
    const dir = conflictFullPath.substring(0, conflictFullPath.lastIndexOf("/"));
    if (dir) await this.ensureFolder(dir);

    try {
      await this.app.vault.createBinary(conflictFullPath, data.slice(0));
      await this.publishBinaryFile(conflictRel, conflictFullPath, undefined, `binary-conflict-${reason}`);
      trace("blob", "binary-conflict-copy", {
        shareId: this.histShareId,
        relPath: safeRel,
        conflictRel,
        localMtime: file.stat.mtime,
        remoteUpdatedAt: remoteEntry?.blobUpdatedAt || remoteEntry?.lastModified || 0,
        remoteHash: remoteEntry?.blobHash,
        reason,
      });
      log("blob", "created binary conflict copy", safeRel, "->", conflictRel);
      return conflictRel;
    } catch (e) {
      trace("blob", "binary-conflict-copy-failed", {
        shareId: this.histShareId,
        relPath: safeRel,
        conflictRel,
        error: e,
        reason,
      });
      log("blob", "binary conflict copy failed", safeRel, e);
      return null;
    }
  }

  private nextConflictRelPath(safeRel: string, label: string, context: string): string | null {
    const slash = safeRel.lastIndexOf("/");
    const dir = slash >= 0 ? safeRel.slice(0, slash + 1) : "";
    const name = slash >= 0 ? safeRel.slice(slash + 1) : safeRel;
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");

    for (let i = 0; i < 100; i++) {
      const suffix = i === 0 ? "" : ` ${i + 1}`;
      const candidate = `${dir}${base} (${label} ${stamp}${suffix})${ext}`;
      const safeCandidate = this.safeManifestRelPath(candidate, context);
      if (!safeCandidate) continue;
      if (this.manifestMap?.has(safeCandidate)) continue;
      if (this.app.vault.getAbstractFileByPath(this.toFullPath(safeCandidate))) continue;
      return safeCandidate;
    }
    trace("manifest", "tombstone-conflict-path-exhausted", {
      shareId: this.histShareId,
      relPath: safeRel,
      label,
    });
    return null;
  }

  // In-flight provider creations, so two concurrent callers for the same path
  // can't both pass the `has()` check and create duplicate providers/sockets.
  private creatingProviders: Map<string, Promise<void>> = new Map();

  /** Create a FileProvider for a file. `seedState` clones a full Y.Doc into the
   *  new room (rename content-transfer — preserves text, comments, and anchors). */
  private async createFileProvider(relPath: string, fullPath: string, opts?: { seedState?: Uint8Array | null }): Promise<void> {
    if (this.fileProviders.has(relPath)) return;
    const inflight = this.creatingProviders.get(relPath);
    if (inflight) return inflight;

    const task = (async () => {
      trace("file", "provider-create-start", {
        shareId: this.histShareId,
        relPath,
        fullPath,
        hasSeedState: !!opts?.seedState,
      });
      // Read initial content
      let content = "";
      const file = this.app.vault.getAbstractFileByPath(fullPath);
      if (file instanceof TFile) {
        content = await this.app.vault.read(file);
      }

      const fp = new FileProvider({
        app: this.app,
        settings: this.settings,
        filePath: fullPath,
        roomName: fileRoom(this.share, relPath),
        shareId: this.histShareId,
        token: shareToken(this.share, this.settings.serverPassword),
        authParams: this.providerAuthParams(),
        echo: this.echo,
        onStatusChange: () => {},  // Individual file status not shown
        onUsersChange: (users) => this.onUsersChange(users),
        onLocalEdit: () => this.stampEdit(relPath),
        onPending: () => this.debouncedStatus(),
      });

      await fp.start(content, { seedState: opts?.seedState ?? null });
      this.fileProviders.set(relPath, fp);
      trace("file", "provider-create-done", {
        shareId: this.histShareId,
        relPath,
        fullPath,
        initialLen: content.length,
      });
    })();

    this.creatingProviders.set(relPath, task);
    try {
      await task;
    } finally {
      this.creatingProviders.delete(relPath);
    }
  }

  private entryKind(relPath: string, entry?: ManifestEntry): "text" | "binary" {
    if (entry?.kind === "binary") return "binary";
    return isSyncableBinaryPath(relPath) ? "binary" : "text";
  }

  private blobQuery(params: Record<string, string | number>): string {
    const q = new URLSearchParams();
    q.set("token", shareToken(this.share, this.settings.serverPassword));
    for (const [key, value] of Object.entries(shareAuthParams(this.share))) q.set(key, value);
    if (this.share.inviteId && this.settings.identityPublicKey && this.settings.identitySignature) {
      q.set("uid", this.settings.uid);
      q.set("identityKey", this.settings.identityPublicKey);
      q.set("identitySig", this.settings.identitySignature);
    }
    for (const [key, value] of Object.entries(params)) q.set(key, String(value));
    return q.toString();
  }

  private async readBinaryInfo(file: TFile): Promise<{ data: ArrayBuffer; hash: string; size: number } | null> {
    try {
      const data = await this.app.vault.readBinary(file);
      if (data.byteLength > MAX_SYNCABLE_BINARY_BYTES) {
        new Notice(`"${file.name}" is too large to sync as an attachment.`);
        trace("blob", "local-too-large", { path: file.path, size: data.byteLength, max: MAX_SYNCABLE_BINARY_BYTES });
        return null;
      }
      return { data, hash: await sha256Hex(data), size: data.byteLength };
    } catch (e) {
      trace("blob", "read-error", { path: file.path, error: e });
      return null;
    }
  }

  private async publishBinaryFile(relPath: string, fullPath: string, prev?: ManifestEntry, reason = "local"): Promise<void> {
    if (!this.manifestMap || this.role !== "editor") return;
    const safeRel = this.safeManifestRelPath(relPath, `binary ${reason}`);
    if (!safeRel || !isSyncableBinaryPath(safeRel)) return;
    const file = this.app.vault.getAbstractFileByPath(fullPath);
    if (!(file instanceof TFile)) return;
    const info = await this.readBinaryInfo(file);
    if (!info) return;
    if (prev?.kind === "binary" && prev.blobHash === info.hash && prev.blobSize === info.size) return;

    const url = `${httpBase(this.settings.serverUrl)}/blob?${this.blobQuery({
      share: this.histShareId,
      path: safeRel,
      hash: info.hash,
      size: info.size,
    })}`;
    const res = await putBinary(url, info.data);
    if (!res.ok) {
      trace("blob", "upload-failed", { shareId: this.histShareId, relPath: safeRel, status: res.status, hash: info.hash, size: info.size });
      new Notice(`Could not sync attachment "${file.name}" (${res.status}).`);
      return;
    }

    const fileId = prev?.fileId || this.fileIds.get(safeRel) || newFileId();
    const mutation = this.manifestMutation(`binary-${reason}`);
    this.fileIds.set(safeRel, fileId);
    this.manifestMap.set(safeRel, liveManifestEntry(prev, safeRel, fileId, this.settings.displayName, {
      kind: "binary",
      blobHash: info.hash,
      blobSize: info.size,
      blobUpdatedAt: mutation.mutationAt,
      ...mutation,
    }));
    trace("blob", "published", { shareId: this.histShareId, relPath: safeRel, hash: info.hash, size: info.size, reason });
  }

  private async applyRemoteBinary(relPath: string, entry: ManifestEntry, reason: "startup" | "live" = "live"): Promise<void> {
    const safeRel = this.safeManifestRelPath(relPath, "remote binary");
    if (!safeRel || !entry.blobHash) return;
    const fullPath = this.toFullPath(safeRel);
    const existing = this.app.vault.getAbstractFileByPath(fullPath);
    if (existing instanceof TFile) {
      const local = await this.readBinaryInfo(existing);
      if (local?.hash === entry.blobHash && local.size === entry.blobSize) return;
      if (local && this.role === "editor") {
        const remoteUpdatedAt = entry.blobUpdatedAt || entry.lastModified || 0;
        const decision = binaryRemoteDecision(existing.stat.mtime, remoteUpdatedAt);
        if (decision === "keep-local") {
          trace("blob", "kept-local-newer", {
            shareId: this.histShareId,
            relPath: safeRel,
            localHash: local.hash,
            remoteHash: entry.blobHash,
            localMtime: existing.stat.mtime,
            remoteUpdatedAt,
          });
          new Notice(`Kept newer local attachment "${existing.name}" and re-published it.`);
          await this.publishBinaryFile(safeRel, fullPath, entry, "live-local-newer");
          return;
        }
        if (decision === "conflict-copy") {
          const conflictRel = await this.createBinaryConflictCopy(safeRel, existing, local.data, entry, reason);
          trace("blob", "binary-conflict-copy-before-apply", {
            shareId: this.histShareId,
            relPath: safeRel,
            conflictRel,
            localHash: local.hash,
            remoteHash: entry.blobHash,
            localMtime: existing.stat.mtime,
            remoteUpdatedAt,
            reason,
          });
          if (conflictRel) {
            new Notice(`Attachment "${existing.name}" changed near a remote update — kept a conflict copy at "${conflictRel}".`);
          }
        }
      }
    }

    const url = `${httpBase(this.settings.serverUrl)}/blob?${this.blobQuery({
      share: this.histShareId,
      hash: entry.blobHash,
    })}`;
    const res = await getBinary(url);
    if (!res.ok || !res.body) {
      trace("blob", "download-failed", { shareId: this.histShareId, relPath: safeRel, status: res.status, hash: entry.blobHash });
      return;
    }
    const hash = await sha256Hex(res.body);
    if (hash !== entry.blobHash || (entry.blobSize != null && res.body.byteLength !== entry.blobSize)) {
      trace("blob", "download-hash-mismatch", {
        shareId: this.histShareId,
        relPath: safeRel,
        expectedHash: entry.blobHash,
        actualHash: hash,
        expectedSize: entry.blobSize,
        actualSize: res.body.byteLength,
      });
      return;
    }

    if (existing instanceof TFile) {
      const current = await this.app.vault.readBinary(existing).catch(() => null);
      if (current && buffersEqual(current, res.body)) return;
    } else {
      const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
      if (dir) await this.ensureFolder(dir);
    }

    beginRemoteApply();
    try {
      this.echo.mark(fullPath, hash);
      if (existing instanceof TFile) {
        await this.app.vault.modifyBinary(existing, res.body);
      } else {
        this.echo.markCreated(fullPath);
        await this.app.vault.createBinary(fullPath, res.body);
      }
      trace("blob", "applied", { shareId: this.histShareId, relPath: safeRel, hash, size: res.body.byteLength });
    } finally {
      endRemoteApply();
    }
  }

  /** Create an empty file, marking it so its create event is dropped as an echo. */
  private async guardedCreate(fullPath: string): Promise<void> {
    this.echo.markCreated(fullPath);
    beginRemoteApply();
    try {
      await this.app.vault.create(fullPath, "");
    } catch (e) {
      if (!this.app.vault.getAbstractFileByPath(fullPath)) log("delete", "guardedCreate failed", fullPath, e);
    } finally {
      endRemoteApply();
    }
  }

  /** Delete a file, fingerprinting the deletion so its delete event is dropped as an echo. */
  private async guardedDelete(file: TFile): Promise<void> {
    this.echo.markDeleted(file.path);
    beginRemoteApply();
    try {
      await this.app.vault.delete(file);
    } catch (e) {
      log("delete", "guardedDelete failed", file.path, e);
    } finally {
      endRemoteApply();
    }
  }

  // -- Vault event handlers (routed from main.ts) --

  onFileCreate(file: TFile): void {
    if (!this.isInLinkedFolder(file.path)) return;
    if (!this.isSyncableFile(file)) {
      trace("vault", "create-skipped", { shareId: this.histShareId, path: file.path, cause: "unsupported-file" });
      return;
    }
    if (this.role !== "editor") {
      trace("vault", "create-skipped", { shareId: this.histShareId, path: file.path, cause: "read-only-role", role: this.role });
      return;
    }
    // Drop our own create echo, and any create delivered synchronously while
    // we're applying a remote change.
    if (isApplyingRemote()) {
      trace("vault", "create-skipped", { shareId: this.histShareId, path: file.path, cause: "remote-apply-active" });
      return;
    }
    if (this.echo.isCreatedEcho(file.path)) {
      trace("vault", "create-skipped", { shareId: this.histShareId, path: file.path, cause: "echo" });
      return;
    }

    const relPath = this.toRelativePath(file.path);
    if (!this.safeManifestRelPath(relPath, "local create")) return;
    trace("vault", "local-create", { shareId: this.histShareId, relPath, path: file.path });

    if (isSyncableBinaryPath(relPath)) {
      void this.publishBinaryFile(relPath, file.path, this.manifestMap?.get(relPath) as ManifestEntry | undefined, "create")
        .then(() => this.emitStatus());
      return;
    }

    if (this.manifestMap) {
      const prev = this.manifestMap.get(relPath) as ManifestEntry | undefined;
      // Reuse an existing fileId (re-create at the same path) else mint a new one.
      const fileId = prev?.fileId || newFileId();
      const mutation = this.manifestMutation("create");
      this.fileIds.set(relPath, fileId);
      this.manifestMap.set(relPath, liveManifestEntry(prev, relPath, fileId, this.settings.displayName, mutation));
    }

    if (!this.fileProviders.has(relPath)) {
      this.createFileProvider(relPath, file.path);
    }
    this.emitStatus();
  }

  async onFileModify(file: TFile): Promise<void> {
    if (!this.isInLinkedFolder(file.path)) return;
    if (!this.isSyncableFile(file)) {
      trace("vault", "modify-skipped", { shareId: this.histShareId, path: file.path, cause: "unsupported-file" });
      return;
    }
    if (this.role !== "editor") {
      trace("vault", "modify-skipped", { shareId: this.histShareId, path: file.path, cause: "read-only-role", role: this.role });
      return;
    }
    if (isApplyingRemote()) {
      trace("vault", "modify-skipped", { shareId: this.histShareId, path: file.path, cause: "remote-apply-active" });
      return;
    }

    const relPath = this.toRelativePath(file.path);
    if (!this.safeManifestRelPath(relPath, "local modify")) return;
    if (isSyncableBinaryPath(relPath)) {
      const info = await this.readBinaryInfo(file);
      if (!info) return;
      if (this.echo.isEcho(file.path, info.hash)) {
        trace("vault", "modify-skipped", { shareId: this.histShareId, relPath, path: file.path, cause: "binary-echo", hash: info.hash, size: info.size });
        return;
      }
      await this.publishBinaryFile(relPath, file.path, this.manifestMap?.get(relPath) as ManifestEntry | undefined, "modify");
      this.emitStatus();
      return;
    }
    const fp = this.fileProviders.get(relPath);
    if (fp) {
      const content = await this.app.vault.read(file);
      // Our own write echo (deterministic, content-based — no timing window).
      if (this.echo.isEcho(file.path, content)) {
        trace("vault", "modify-skipped", { shareId: this.histShareId, relPath, path: file.path, cause: "echo", len: content.length });
        return;
      }
      trace("vault", "local-modify", { shareId: this.histShareId, relPath, path: file.path, len: content.length });
      fp.applyLocalChange(content);
    } else {
      trace("vault", "modify-skipped", { shareId: this.histShareId, relPath, path: file.path, cause: "provider-missing" });
    }
  }

  async onFileDelete(file: TFile): Promise<void> {
    if (!this.isInLinkedFolder(file.path)) return;
    if (!this.isSyncableFile(file)) {
      trace("vault", "delete-skipped", { shareId: this.histShareId, path: file.path, cause: "unsupported-file" });
      return;
    }
    if (this.role !== "editor") {
      trace("vault", "delete-skipped", { shareId: this.histShareId, path: file.path, cause: "read-only-role", role: this.role });
      return;
    }
    if (isApplyingRemote()) {
      trace("vault", "delete-skipped", { shareId: this.histShareId, path: file.path, cause: "remote-apply-active" });
      return;
    }
    if (this.echo.isDeletedEcho(file.path)) {
      trace("vault", "delete-skipped", { shareId: this.histShareId, path: file.path, cause: "echo" });
      return;
    }

    const relPath = this.toRelativePath(file.path);
    if (!this.safeManifestRelPath(relPath, "local delete")) return;
    trace("vault", "local-delete", { shareId: this.histShareId, relPath, path: file.path });
    const fp = this.fileProviders.get(relPath);

    // Never lose stuff: snapshot + trash the content BEFORE tearing the doc down.
    if (fp) {
      await fp.flushSnapshot();
      await fp.saveToTrash();
    }

    if (this.manifestMap) {
      const prev = this.manifestMap.get(relPath) as ManifestEntry | undefined;
      const mutation = this.manifestMutation("delete");
      this.manifestMap.set(relPath, {
        ...(prev || {}),
        path: relPath,
        exists: false,
        deleted: true,
        ...mutation,
        deletedBy: this.settings.displayName,
        deletedAt: mutation.mutationAt,
      });
    }
    this.fileIds.delete(relPath);

    if (fp) {
      fp.destroyAndClearData();
      this.fileProviders.delete(relPath);
    }
    log("delete", "tombstoned", relPath);
    this.emitStatus();
  }

  /**
   * Rename. A true within-share rename TRANSFERS the file's identity (fileId)
   * and full Y.Doc state (text + comments + anchors + history) into the new
   * room, then tombstones the old path with `renamedTo`. Moving out of the share
   * is a delete; moving in is a create. Obsidian has already moved the file on
   * disk by the time this fires, so we never create/delete disk files here.
   */
  async onFileRename(file: TFile, oldPath: string): Promise<void> {
    if (this.role !== "editor") return;
    if (isApplyingRemote()) return; // never re-enter while applying a remote change
    const oldWasSyncable = this.isInLinkedFolder(oldPath) && isSyncablePath(oldPath);
    const newIsSyncable = this.isInLinkedFolder(file.path) && this.isSyncableFile(file);
    trace("vault", "local-rename", {
      shareId: this.histShareId,
      oldPath,
      newPath: file.path,
      oldWasSyncable,
      newIsSyncable,
    });

    if (oldWasSyncable && newIsSyncable && isSyncableTextPath(oldPath) && isSyncableTextPath(file.path)) {
      await this.transferRename(oldPath, file.path);
    } else if (oldWasSyncable && newIsSyncable && isSyncableBinaryPath(oldPath) && isSyncableBinaryPath(file.path)) {
      await this.transferBinaryRename(oldPath, file.path);
    } else if (oldWasSyncable && newIsSyncable) {
      await this.tombstoneByRelPath(this.toRelativePath(oldPath));
      this.onFileCreate(file);
    } else if (oldWasSyncable && !newIsSyncable) {
      // Moved/renamed out of the share → treat as a delete of the old path.
      await this.tombstoneByRelPath(this.toRelativePath(oldPath));
    } else if (!oldWasSyncable && newIsSyncable) {
      // Moved into the share → treat as a create.
      this.onFileCreate(file);
    }
  }

  /**
   * Folder move/rename. Obsidian fires a SINGLE rename event for the folder (no
   * per-child events), so we re-derive each descendant synced file's old path by
   * prefix substitution and route it through the per-file rename — preserving
   * content, comments, identity, and version lineage for every moved file.
   */
  async onFolderRename(folder: TFolder, oldFolderPath: string): Promise<void> {
    if (this.role !== "editor") return;
    if (isApplyingRemote()) return;
    const newPrefix = folder.path; // folder is already at its NEW path
    const children: TFile[] = [];
    const walk = (f: TFolder) => {
      for (const c of f.children) {
        if (c instanceof TFile && this.isSyncableFile(c)) children.push(c);
        else if (c instanceof TFolder) walk(c);
      }
    };
    walk(folder);
    for (const child of children) {
      if (child.path !== newPrefix && !child.path.startsWith(newPrefix + "/")) continue;
      const oldChildPath = oldFolderPath + child.path.slice(newPrefix.length); // suffix incl. leading "/"
      await this.onFileRename(child, oldChildPath);
    }
  }

  /**
   * Folder delete. The children are already gone from disk, so we work from the
   * manifest: tombstone every LIVE entry whose path falls under the deleted
   * folder. Idempotent — harmless if per-child delete events also fired.
   */
  async onFolderDelete(oldFolderPath: string): Promise<void> {
    if (this.role !== "editor") return;
    if (isApplyingRemote()) return;
    if (!this.manifestMap) return;
    const prefixFull = oldFolderPath.replace(/\/+$/, "") + "/";
    const toTomb: string[] = [];
    this.manifestMap.forEach((entry: any, relPath: string) => {
      if (!entry || entry.exists === false) return;
      const full = this.toFullPath(relPath);
      if (full.startsWith(prefixFull)) toTomb.push(relPath);
    });
    for (const relPath of toTomb) await this.tombstoneByRelPath(relPath);
  }

  /** Tombstone a relPath whose disk file is already gone (rename-out / move). */
  private async tombstoneByRelPath(oldRel: string): Promise<void> {
    if (!this.safeManifestRelPath(oldRel, "local tombstone")) return;
    const fp = this.fileProviders.get(oldRel);
    if (fp) { await fp.flushSnapshot(); await fp.saveToTrash(); }
    if (this.manifestMap) {
      const prev = this.manifestMap.get(oldRel) as ManifestEntry | undefined;
      const mutation = this.manifestMutation("delete-moved-out");
      this.manifestMap.set(oldRel, {
        ...(prev || {}), path: oldRel, exists: false, deleted: true,
        ...mutation, deletedBy: this.settings.displayName, deletedAt: mutation.mutationAt,
      });
    }
    this.fileIds.delete(oldRel);
    if (fp) { fp.destroyAndClearData(); this.fileProviders.delete(oldRel); }
    log("delete", "tombstoned (moved out)", oldRel);
    this.emitStatus();
  }

  /** Content-transfer a rename: clone old room state into the new room, same fileId. */
  private async transferRename(oldPath: string, newPath: string): Promise<void> {
    const oldRel = this.toRelativePath(oldPath);
    const newRel = this.toRelativePath(newPath);
    if (!this.safeManifestRelPath(oldRel, "local rename old")) return;
    if (!this.safeManifestRelPath(newRel, "local rename new")) return;
    if (oldRel === newRel) return;
    trace("manifest", "rename-transfer-start", { shareId: this.histShareId, oldRel, newRel });

    const oldFp = this.fileProviders.get(oldRel);
    const oldEntry = (this.manifestMap?.get(oldRel) as ManifestEntry | undefined) || ({} as ManifestEntry);
    const fileId = oldEntry.fileId || this.fileIds.get(oldRel) || newFileId();
    // Capture the full doc state (text + comments) BEFORE teardown; snapshot too.
    const state = oldFp ? oldFp.encodeState() : null;
    if (oldFp) await oldFp.flushSnapshot();

    // Tear down the old local provider (server room + IDB linger harmlessly).
    if (oldFp) { oldFp.destroy(); this.fileProviders.delete(oldRel); }
    this.fileIds.delete(oldRel);

    // Create the new room seeded from the old doc's state (so the new file room
    // is authoritative) BEFORE writing the manifest, so the manifest observe
    // doesn't race to create an un-seeded provider.
    this.fileIds.set(newRel, fileId);
    if (!this.fileProviders.has(newRel)) {
      await this.createFileProvider(newRel, newPath, { seedState: state });
    }

    if (this.manifestMap) {
      const mutation = this.manifestMutation("rename");
      this.manifestDoc!.transact(() => {
        // New entry: same identity, new path.
        this.manifestMap!.set(newRel, liveManifestEntry(oldEntry, newRel, fileId, this.settings.displayName, {
          renamedFrom: oldRel,
          ...mutation,
        }));
        // Old path: tombstone pointing at the new path.
        this.manifestMap!.set(oldRel, {
          ...oldEntry, fileId, path: oldRel, exists: false, deleted: true,
          renamedTo: newRel, ...mutation,
          deletedBy: this.settings.displayName, deletedAt: mutation.mutationAt,
        });
      });
    }
    log("delete", "renamed", oldRel, "→", newRel, "(content transferred)");
    trace("manifest", "rename-transfer-done", { shareId: this.histShareId, oldRel, newRel, fileId });
    this.emitStatus();
  }

  /** Rename a binary attachment by moving its blob metadata to the new path. */
  private async transferBinaryRename(oldPath: string, newPath: string): Promise<void> {
    const oldRel = this.toRelativePath(oldPath);
    const newRel = this.toRelativePath(newPath);
    if (!this.safeManifestRelPath(oldRel, "local binary rename old")) return;
    if (!this.safeManifestRelPath(newRel, "local binary rename new")) return;
    if (oldRel === newRel) return;
    const oldEntry = (this.manifestMap?.get(oldRel) as ManifestEntry | undefined) || ({} as ManifestEntry);
    if (!oldEntry.blobHash) {
      await this.publishBinaryFile(newRel, newPath, undefined, "rename-create");
      await this.tombstoneByRelPath(oldRel);
      return;
    }
    const fileId = oldEntry.fileId || this.fileIds.get(oldRel) || newFileId();
    this.fileIds.delete(oldRel);
    this.fileIds.set(newRel, fileId);
    if (this.manifestMap) {
      const mutation = this.manifestMutation("binary-rename");
      this.manifestDoc!.transact(() => {
        this.manifestMap!.set(newRel, liveManifestEntry(oldEntry, newRel, fileId, this.settings.displayName, {
          kind: "binary",
          blobHash: oldEntry.blobHash,
          blobSize: oldEntry.blobSize,
          blobUpdatedAt: oldEntry.blobUpdatedAt || oldEntry.lastModified || mutation.mutationAt,
          renamedFrom: oldRel,
          ...mutation,
        }));
        this.manifestMap!.set(oldRel, {
          ...oldEntry, fileId, path: oldRel, exists: false, deleted: true,
          renamedTo: newRel, ...mutation,
          deletedBy: this.settings.displayName, deletedAt: mutation.mutationAt,
        });
      });
    }
    trace("blob", "renamed", { shareId: this.histShareId, oldRel, newRel, fileId, hash: oldEntry.blobHash });
    this.emitStatus();
  }

  private async rewriteLinksForRemoteRename(oldRelCandidate: unknown, newRelCandidate: string, fileId?: string): Promise<void> {
    if (this.role !== "editor" || !oldRelCandidate) return;
    const oldRel = this.safeManifestRelPath(oldRelCandidate, "link rewrite old");
    const newRel = this.safeManifestRelPath(newRelCandidate, "link rewrite new");
    if (!oldRel || !newRel || oldRel === newRel) return;

    const key = `${fileId || ""}:${oldRel}->${newRel}`;
    if (this.linkRewriteRenames.has(key)) return;
    this.linkRewriteRenames.add(key);

    let scanned = 0;
    let changed = 0;
    let replacements = 0;
    let skipped = 0;

    for (const filePath of this.getLocalFiles()) {
      if (!/\.md$/i.test(filePath)) continue;
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) continue;
      const sourceRel = this.toRelativePath(filePath);
      if (!this.safeManifestRelPath(sourceRel, "link rewrite source")) continue;
      const sourceEntry = this.manifestMap?.get(sourceRel) as ManifestEntry | undefined;
      if (!sourceEntry?.exists || this.entryKind(sourceRel, sourceEntry) !== "text") continue;
      scanned++;

      let existingProvider = this.fileProviders.get(sourceRel);
      if (!existingProvider) {
        await this.createFileProvider(sourceRel, filePath);
        existingProvider = this.fileProviders.get(sourceRel);
      }
      const provider = existingProvider ? await this.waitForUsableFileProvider(sourceRel, 6000) : null;
      const current = provider ? provider.getText() : await this.app.vault.read(file);
      const result = rewriteObsidianLinks(current, {
        oldRelPath: oldRel,
        newRelPath: newRel,
        sourceRelPath: sourceRel,
        resolveLink: (linkPath, source) => this.resolveWikiLinkRel(linkPath, source),
      });
      if (result.replacements === 0) continue;

      replacements += result.replacements;
      if (provider) {
        if (await provider.applyProgrammaticChange(result.content, "link-rewrite-rename")) changed++;
      } else {
        skipped++;
        trace("manifest", "link-rewrite-skipped", {
          shareId: this.histShareId,
          oldRel,
          newRel,
          sourceRel,
          reason: "provider-not-ready",
        });
      }
    }

    trace("manifest", "link-rewrite-rename", {
      shareId: this.histShareId,
      oldRel,
      newRel,
      fileId,
      scanned,
      changed,
      replacements,
      skipped,
    });
  }

  private async waitForUsableFileProvider(relPath: string, timeoutMs: number): Promise<FileProvider | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const fp = this.fileProviders.get(relPath);
      if (!fp) return null;
      if (fp.isReady() || fp.getText().length > 0) return fp;
      await sleepMs(150);
    }
    const fp = this.fileProviders.get(relPath);
    return fp && (fp.isReady() || fp.getText().length > 0) ? fp : null;
  }

  private resolveWikiLinkRel(linkPath: string, sourceRel: string): string | null {
    const cache = (this.app as any).metadataCache;
    const sourceFullPath = this.toFullPath(sourceRel);
    const dest = cache?.getFirstLinkpathDest?.(linkPath, sourceFullPath);
    if (dest instanceof TFile && this.isInLinkedFolder(dest.path)) return this.toRelativePath(dest.path);
    return null;
  }

  /** Broadcast which file (if any) this user has open, for presence avatars. */
  setPresence(activeFile: TFile | null): void {
    if (!this.manifestProvider) return;
    let relPath: string | null = null;
    if (activeFile && this.isInLinkedFolder(activeFile.path)) {
      const candidate = this.toRelativePath(activeFile.path);
      relPath = this.safeManifestRelPath(candidate, "local presence");
    }
    trace("presence", "active-file", {
      shareId: this.histShareId,
      path: activeFile?.path ?? null,
      relPath,
    });
    const cur = this.manifestProvider.awareness.getLocalState()?.presence || {};
    this.manifestProvider.awareness.setLocalStateField("presence", { ...cur, activeFile: relPath });
  }

  /** The FileProvider owning a vault path (for the editor yCollab binding). */
  getFileProvider(fullPath: string): FileProvider | null {
    if (!this.isInLinkedFolder(fullPath)) return null;
    return this.fileProviders.get(this.toRelativePath(fullPath)) ?? null;
  }

  // ── Deleted-file recovery (Phase B) ────────────────────────────────────────

  /** Tombstoned (deleted) files in this share's manifest — the "Deleted files" list. */
  listDeletedFiles(): { relPath: string; deletedBy?: string; deletedAt?: number }[] {
    if (!this.manifestMap) return [];
    const out: { relPath: string; deletedBy?: string; deletedAt?: number }[] = [];
    this.manifestMap.forEach((entry: any, relPath: string) => {
      if (!this.safeManifestRelPath(relPath, "deleted-files list")) return;
      if (isRecoverableTombstone(entry)) {
        out.push({ relPath, deletedBy: entry.deletedBy, deletedAt: entry.deletedAt || entry.lastModified });
      }
    });
    out.sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
    return out;
  }

  /**
   * Un-delete a tombstoned file. Flipping the manifest entry to exists:true makes
   * handleManifestChange (here AND on peers) recreate the file from the RETAINED
   * server room content — no local re-seeding, so no risk of CRDT duplication.
   * The server never discards a file room's content on delete, so the full last
   * content comes back. Older versions remain available via normal history.
   */
  async restoreDeletedFile(relPath: string): Promise<boolean> {
    if (this.role !== "editor") { new Notice("This share is read-only on this device."); return false; }
    if (!this.manifestMap) return false;
    const safeRel = this.safeManifestRelPath(relPath, "restore deleted");
    if (!safeRel) return false;
    const prev = this.manifestMap.get(safeRel) || {};
    const fileId = prev.fileId || this.fileIds.get(safeRel) || newFileId();
    const mutation = this.manifestMutation("restore");
    this.fileIds.set(safeRel, fileId);
    this.manifestMap.set(safeRel, {
      ...liveManifestEntry(prev, safeRel, fileId, this.settings.displayName, mutation),
      restoredBy: this.settings.displayName,
      restoredAt: mutation.mutationAt,
    });
    log("delete", "restore requested", safeRel);

    // Primary path: the flipped tombstone makes handleManifestChange recreate
    // the file from the retained server room content (no re-seed → no dup).
    // Safety net: if that room turns out EMPTY (server content lost / wiped),
    // seed from the local trash copy. Empty→content via restoreFromText is a
    // dup-safe CRDT diff, so this only ever helps.
    const trash = await this.readLatestTrash(safeRel);
    if (trash) {
      setTimeout(async () => {
        const fp = this.fileProviders.get(safeRel);
        if (fp && fp.isReady() && fp.getText().length === 0) {
          await fp.restoreFromText(trash);
          log("delete", "restored content from local trash (server room was empty)", safeRel);
        }
      }, 2500);
    }
    return true;
  }

  /** Newest local-trash content for a deleted relPath, if any (offline fallback). */
  async readLatestTrash(relPath: string): Promise<string | null> {
    const safeRel = this.safeManifestRelPath(relPath, "read trash");
    if (!safeRel) return null;
    return FileProvider.readLatestTrash(this.app, this.histShareId, this.toFullPath(safeRel));
  }

  /**
   * Render colored letter-avatar badges in the file explorer for collaborators
   * who have a file in THIS share open. Diffed (skips when nothing changed) and
   * called on a debounce, so awareness churn doesn't thrash the DOM.
   *
   * Opportunistic outside the editor: desktop has stable enough file/tree tab
   * anchors, while mobile may expose different drawers across app versions. If
   * the expected anchors are absent, this logs missing targets and the in-editor
   * CM6 facepile still carries presence on every platform.
   */
  private renderPresence(): void {
    if (!this.manifestProvider) return;
    try {
      this.renderPresenceDesktop();
    } catch (e) {
      // Never let a DOM/selector quirk throw out of an awareness callback.
      log("offline", "renderPresence skipped", e);
    }
  }

  private renderPresenceDesktop(): void {
    const fileUsers = this.collectFilePresence();

    // Skip if nothing changed since the last render
    const sig = JSON.stringify(
      Array.from(fileUsers.entries())
        .map(([path, users]) => [path, users.map((u) => [u.presenceKey, u.typing, u.hasCaret, u.color])])
        .sort()
    );
    if (sig === this.lastPresenceSig) return;
    this.lastPresenceSig = sig;

    const fileRendered = this.renderFileTreePresence(fileUsers);
    const tabRendered = this.renderTabPresence(fileUsers);
    trace("presence", "rendered", {
      shareId: this.histShareId,
      activeFiles: fileUsers.size,
      fileBadges: fileRendered.rendered,
      fileMissing: fileRendered.missing,
      tabBadges: tabRendered.rendered,
      tabMissing: tabRendered.missing,
    });
  }

  private collectFilePresence(): Map<string, PresenceDevice[]> {
    const rels = new Set<string>();
    this.manifestProvider.awareness.getStates().forEach((state: any) => {
      const candidate = state?.presence?.activeFile;
      if (!candidate) return;
      const safeRel = this.safeManifestRelPath(candidate, "remote presence");
      if (safeRel) rels.add(safeRel);
    });

    const caretByRel = this.collectCaretKeysByRel();
    const out = new Map<string, PresenceDevice[]>();
    for (const relPath of rels) {
      const users = collectPresenceDevices({
        manifestAwareness: this.manifestProvider.awareness,
        relPath,
        caretKeys: caretByRel.get(relPath),
      });
      if (users.length > 0) out.set(this.toFullPath(relPath), users);
    }
    return out;
  }

  private collectCaretKeysByRel(): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const [relPath, fp] of this.fileProviders) {
      const aw = fp.getAwareness();
      if (!aw) continue;
      aw.getStates().forEach((state: any, clientId: number) => {
        if (!state?.user?.uid || !state?.cursor) return;
        if (!out.has(relPath)) out.set(relPath, new Set());
        out.get(relPath)!.add(presenceKeyFromState(state, clientId));
      });
    }
    return out;
  }

  private renderFileTreePresence(fileUsers: Map<string, PresenceDevice[]>): { rendered: number; missing: number } {
    clearRenderedPresence(this.renderedPresence);
    let rendered = 0;
    let missing = 0;

    for (const [fullPath, users] of fileUsers) {
      const fileEl = findFileTreeTitle(document, fullPath);
      if (!fileEl) {
        missing++;
        trace("presence", "file-anchor-missing", { shareId: this.histShareId, path: fullPath, users: users.length });
        continue;
      }

      const host = appendPresenceHost(fileEl, "collab-file-presence-host", users, "file", () => this.followPresence(fullPath));
      this.renderedPresence.set(fullPath, [host]);
      rendered++;
    }
    return { rendered, missing };
  }

  private renderTabPresence(fileUsers: Map<string, PresenceDevice[]>): { rendered: number; missing: number } {
    clearRenderedPresence(this.renderedTabPresence);
    let rendered = 0;
    let missing = 0;

    this.app.workspace.iterateAllLeaves((leaf: any) => {
      const path = leaf?.view?.file?.path as string | undefined;
      if (!path) return;
      const users = fileUsers.get(path);
      if (!users || users.length === 0) return;
      const header = tabHeaderForLeaf(leaf);
      if (!header) {
        missing++;
        trace("presence", "tab-header-missing", { shareId: this.histShareId, path, users: users.length });
        return;
      }
      const host = appendPresenceHost(tabPresenceTarget(header), "collab-tab-presence-host", users, "tab", () => this.followPresence(path));
      this.renderedTabPresence.set(`${this.histShareId}:${path}:${this.renderedTabPresence.size}`, [host]);
      rendered++;
    });
    return { rendered, missing };
  }

  private async followPresence(fullPath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(fullPath);
    if (!(file instanceof TFile)) {
      new Notice("That collaborator's file is not available locally yet.");
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  private clearPresenceUi(): void {
    clearRenderedPresence(this.renderedPresence);
    clearRenderedPresence(this.renderedTabPresence);
    this.lastPresenceSig = "";
  }

  /** Stop syncing this share */
  async destroy(): Promise<void> {
    this.clearPresenceUi();

    for (const [, fp] of this.fileProviders) fp.destroy();
    this.fileProviders.clear();

    if (this.manifestProvider) this.manifestProvider.destroy();
    if (this.manifestDoc) this.manifestDoc.destroy();

    this.syncStatus = "disconnected";
    this.onStatusChange("disconnected", 0, 0);
  }

  // -- Helpers --

  isInLinkedFolder(path: string): boolean {
    const folder = this.share.localFolder;
    if (!folder) return false;
    return path.startsWith(folder + "/") || path === folder;
  }

  private toRelativePath(fullPath: string): string {
    return fullPath.substring(this.share.localFolder.length + 1);
  }

  private toFullPath(relPath: string): string {
    return this.share.localFolder + "/" + relPath;
  }

  private safeManifestRelPath(relPath: unknown, context: string): string | null {
    const safe = safeRelPath(relPath, this.share.localFolder);
    if (!safe) log("loop", "rejected unsafe manifest path", context, String(relPath));
    return safe;
  }

  private providerAuthParams(): Record<string, string> {
    return {
      ...shareAuthParams(this.share),
      ...(this.share.legacy ? {} : { __mux: "true" }),
    };
  }

  private getLocalFiles(): string[] {
    const folder = this.app.vault.getAbstractFileByPath(this.share.localFolder);
    if (!(folder instanceof TFolder)) return [];
    const files: string[] = [];
    const recurse = (f: TFolder) => {
      for (const child of f.children) {
        if (child instanceof TFile && this.isSyncableFile(child)) {
          files.push(child.path);
        } else if (child instanceof TFolder) {
          recurse(child);
        }
      }
    };
    recurse(folder);
    return files;
  }

  private async ensureFolder(path: string): Promise<void> {
    const clean = path.replace(/\/+$/, "");
    if (!clean) return;
    const parts = clean.split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(cur);
      if (existing instanceof TFolder) continue;
      if (existing) throw new Error(`Cannot create folder "${cur}"; a file exists there.`);
      await this.app.vault.createFolder(cur).catch((e) => {
        if (!this.app.vault.getAbstractFileByPath(cur)) throw e;
      });
    }
  }

  private isSyncableFile(file: TFile): boolean {
    return isSyncablePath(file.path);
  }
}
