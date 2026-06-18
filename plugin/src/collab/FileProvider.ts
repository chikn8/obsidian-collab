import { App, TFile, Notice } from "obsidian";
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import { createProvider } from "./YjsProvider";
import { EchoGuard, beginRemoteApply, endRemoteApply } from "./EchoGuard";
import { diffRange } from "../utils/textDiff";
import { log, trace } from "../utils/log";
import { pluginDataPath } from "../utils/pluginPaths";
import { colorFor } from "../types";
import type { CollabPluginSettings, ConnectionStatus, ConnectedUser } from "../types";

function backupDir(app: App): string {
  return pluginDataPath(app, "backups");
}

function trashDir(app: App): string {
  return pluginDataPath(app, "trash");
}

function backupExtension(fullPath: string): string {
  const ext = fullPath.split("/").pop()?.split(".").pop()?.toLowerCase() || "md";
  return ext === "canvas" ? "canvas" : "md";
}

/**
 * Headless-only file sync with offline persistence.
 *
 * Remote changes: ytext.observe → write to local file
 * Local changes:  vault.on("modify") → read file → diff into ytext
 *
 * Three layers of data-loss prevention:
 *
 *  1. IndexedDB persistence — Yjs CRDT ops survive app restarts.
 *     Offline edits merge correctly when WebSocket reconnects.
 *
 *  2. Pre-overwrite snapshots — before sync overwrites a local file,
 *     the previous disk content is saved to backups/ for recovery.
 *
 *  3. Disk reconciliation — if the file on disk has edits that never
 *     made it into Yjs (crash between Obsidian save and plugin
 *     processing), those edits are captured into Yjs before the
 *     WebSocket sync, so they participate in the CRDT merge.
 */
export class FileProvider {
  private app: App;
  private settings: CollabPluginSettings;
  filePath: string;
  private roomName: string;
  private shareId: string;
  private ydoc!: Y.Doc;
  private ytext!: Y.Text;
  private provider: any;
  private idbProvider: IndexeddbPersistence | null = null;
  private observer: any = null;
  private echo: EchoGuard;
  private onStatusChange: (status: ConnectionStatus) => void;
  private onUsersChange: (users: ConnectedUser[]) => void;
  private isInitialized = false;
  private destroyed = false;
  private writing = false;
  // Offline state: count local edits made while the socket isn't synced so the
  // status bar can surface "N changes will sync when you reconnect".
  private connected = false;
  private pending = 0;
  /** When the active editor is bound via yCollab, it owns this doc — the
   *  headless disk round-trip is suppressed to avoid double-apply/flicker. */
  private editorBound = false;
  private editorFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private writeSeq = 0;
  private token: string;
  private authParams: Record<string, string>;

  constructor(params: {
    app: App;
    settings: CollabPluginSettings;
    filePath: string;
    roomName: string;
    shareId: string;
    token: string;
    authParams?: Record<string, string>;
    echo: EchoGuard;
    onStatusChange: (status: ConnectionStatus) => void;
    onUsersChange: (users: ConnectedUser[]) => void;
    onLocalEdit?: () => void;
    onPending?: () => void;
  }) {
    this.app = params.app;
    this.settings = params.settings;
    this.filePath = params.filePath;
    this.roomName = params.roomName;
    this.shareId = params.shareId;
    this.token = params.token;
    this.authParams = params.authParams ?? {};
    this.echo = params.echo;
    this.onStatusChange = params.onStatusChange;
    this.onUsersChange = params.onUsersChange;
    this.onLocalEdit = params.onLocalEdit;
    this.onPending = params.onPending;
  }

  /** Local edits made while offline that haven't synced yet. */
  pendingOffline(): number {
    return this.pending;
  }

  private onLocalEdit?: () => void;
  private onPending?: () => void;

  /** Force a reconnect of this file's socket (used by "Reconnect all"). */
  reconnect(): void {
    const p = this.provider;
    if (!p) return;
    try { p.wsUnsuccessfulReconnects = 0; p.disconnect(); p.connect(); } catch (e) { /* ignore */ }
  }

  /** Y.Text + awareness for the active-editor yCollab binding. */
  getYText(): Y.Text { return this.ytext; }
  getAwareness(): any { return this.provider?.awareness ?? null; }
  getProvider(): any { return this.provider; }
  getDoc(): Y.Doc { return this.ydoc; }
  isReady(): boolean { return this.isInitialized && !this.destroyed; }

  /** Toggle editor-owned mode. On unbind, flush ytext → disk once and wait for it. */
  async setEditorBound(bound: boolean): Promise<void> {
    const previous = this.editorBound;
    this.editorBound = bound;
    trace("bind", "editor-bound", {
      path: this.filePath,
      room: this.roomName,
      previous,
      bound,
      ready: this.isInitialized,
      len: this.ytext?.length ?? null,
    });
    if (!bound) await this.flushToDisk("editor-unbound");
  }

  /** Force-write current ytext to disk (used when the editor unbinds). */
  async flushToDisk(reason = "manual"): Promise<void> {
    if (this.editorFlushTimer) {
      clearTimeout(this.editorFlushTimer);
      this.editorFlushTimer = null;
    }
    await this.writeToFile(true, reason);
  }

  async start(initialContent?: string, opts?: { seedState?: Uint8Array | null }): Promise<void> {
    trace("file", "start", {
      path: this.filePath,
      room: this.roomName,
      shareId: this.shareId,
      initialLen: initialContent?.length ?? 0,
      hasSeedState: !!opts?.seedState,
    });
    this.ydoc = new Y.Doc();
    this.ytext = this.ydoc.getText("codemirror");

    // ── LAYER 1: IndexedDB persistence ──────────────────────────
    // Persist all Yjs CRDT operations locally. Offline edits survive
    // app restarts and will merge via CRDT when WebSocket reconnects.
    this.idbProvider = new IndexeddbPersistence(
      `obsidian-collab:${this.roomName}`,
      this.ydoc
    );
    await this.idbProvider.whenSynced;
    trace("file", "idb-synced", { path: this.filePath, room: this.roomName, idbLen: this.ytext.length });

    // ── Rename content-transfer: clone the prior file's full Y.Doc state
    // (text + comments + anchors) into this fresh room. Authoritative — skip
    // the disk seed below (the moved disk file already holds the same text).
    if (opts?.seedState) {
      if (this.ytext.length === 0) {
        try {
          Y.applyUpdate(this.ydoc, opts.seedState, "seed");
          log("delete", "seeded renamed room from prior doc state", this.filePath);
        } catch (e) {
          log("delete", "seedState apply failed", this.filePath, e);
        }
      } else {
        // Destination room already holds content (a reused path). Don't merge the
        // seed into it (would duplicate) — the moved disk file's text is captured
        // by the reconciliation below; only Yjs comment-history transfer is lost.
        log("delete", "rename seed skipped (room already had content)", this.filePath);
      }
    }

    // ── LAYER 3: Disk → Yjs reconciliation ──────────────────────
    // Capture edits the file picked up on disk while the plugin was OFF (a
    // crash between Obsidian's save and applyLocalChange, OR the user editing
    // the note in another app / on another device while this one was closed)
    // into Yjs NOW — before the WebSocket sync — so they JOIN the CRDT merge
    // instead of being clobbered by it.
    //
    // The diff base is `idbContent`: the IndexedDB-persisted last-synced text,
    // i.e. the common ancestor. Diffing disk against that ancestor (rather than
    // blind-replacing) means only the genuinely-changed span becomes Yjs ops,
    // so concurrent remote edits elsewhere survive the merge.
    const diskContent = initialContent || "";
    const idbContent = this.ytext.toString();

    if (diskContent.length > 0 && idbContent.length > 0 && idbContent !== diskContent) {
      // IDB gives us a real CRDT base, so the disk delta is a legitimate offline
      // edit. If IDB is empty, defer until after server sync; inserting a whole
      // local file before seeing the server can duplicate the room on join.
      log("offline", "reconciling offline disk edits", this.filePath,
        `(base ${idbContent.length} → disk ${diskContent.length} chars)`);
      await this.saveSnapshot(diskContent).catch((e) => log("offline", "pre-reconcile snapshot failed", e));
      this.applyDiff(idbContent, diskContent);
      trace("file", "offline-reconciled", {
        path: this.filePath,
        room: this.roomName,
        baseLen: idbContent.length,
        diskLen: diskContent.length,
      });
    }

    // ── Connect WebSocket ───────────────────────────────────────
    this.provider = createProvider(
      this.settings.serverUrl,
      this.roomName,
      this.ydoc,
      this.token,
      {
        uid: this.settings.uid,
        name: this.settings.displayName,
        color: this.settings.cursorColor || colorFor(this.settings.uid || this.settings.displayName),
      },
      {
        onStatus: (status) => {
          this.connected = status === "connected";
          trace("ws", "file-status", { path: this.filePath, room: this.roomName, status });
          this.onStatusChange(status);
        },
        // (authParams passed below)
        onSynced: (synced) => {
          trace("ws", "file-synced", {
            path: this.filePath,
            room: this.roomName,
            synced,
            initialized: this.isInitialized,
            pending: this.pending,
            yLen: this.ytext.length,
          });
          if (synced && this.pending > 0) {
            // Reconnected and caught up — the queued offline edits are now sent.
            this.pending = 0;
            this.onPending?.();
          }
          if (synced && !this.isInitialized && !this.destroyed) {
            setTimeout(() => {
              if (this.destroyed || this.isInitialized) return;
              this.isInitialized = true;

              let mergedContent = this.ytext.toString();

              // First client ever: only seed local disk content after proving
              // the server room is still empty. This avoids the whole-file
              // duplicate that happens when a joining client with empty IDB
              // inserts its local copy before receiving the server state.
              if (mergedContent.length === 0 && diskContent.length > 0) {
                this.ydoc.transact(() => {
                  this.ytext.insert(0, diskContent);
                }, "seed");
                mergedContent = diskContent;
              }

              // ── LAYER 2: Pre-overwrite snapshot ─────────────────
              // The CRDT merge is done. If the server already had content and
              // it differs from this disk file, preserve the disk version first
              // and adopt the CRDT state instead of merging a whole-file copy.
              if (diskContent.length > 0 && mergedContent !== diskContent) {
                this.saveSnapshot(diskContent).catch((e) => {
                  console.error("[FileProvider] snapshot failed:", e);
                });
                const fileName = this.filePath.split("/").pop() || this.filePath;
                new Notice(
                  `Sync updated "${fileName}" — pre-sync backup saved`
                );
              }

              // CRDT merge done → write merged result to disk
              if (this.ytext.length > 0) {
                this.writeToFile(false, "initial-sync");
              }

              // Start observing remote changes
              this.startObserver();
            }, 500);
          }
        },
      },
      this.authParams
    );

    this.provider.awareness.on("change", () => {
      this.updateUsers();
    });
  }

  /** Watch ytext changes. Remote changes write to disk; editor-owned local
   *  transactions schedule a responsive disk projection so switching tabs can't
   *  lose the latest CRDT state. */
  private startObserver(): void {
    if (this.observer || this.destroyed) return;

    this.observer = (_event: any, transaction: any) => {
      if (this.destroyed) return;
      // Local edits (typing in the bound editor, or applyLocalChange) → stamp
      // last-edited-by on the manifest (debounced upstream), then we're done.
      if (transaction.local) {
        trace("yjs", "local-transaction", {
          path: this.filePath,
          room: this.roomName,
          origin: originName(transaction.origin),
          editorBound: this.editorBound,
          connected: this.connected,
          len: this.ytext.length,
        });
        this.onLocalEdit?.();
        // Edited while the socket is down → it'll sync on reconnect. Surface it.
        if (!this.connected && transaction.origin !== "seed") {
          this.pending++;
          this.onPending?.();
        }
        if (this.editorBound && transaction.origin !== "seed") {
          this.scheduleEditorFlush("editor-local-transaction");
        }
        return;
      }
      if (this.writing) return;
      // While the editor owns this doc (yCollab), it renders remote changes
      // itself and Obsidian persists them — skip the headless disk write.
      if (this.editorBound) {
        trace("yjs", "remote-transaction-rendered-by-editor", {
          path: this.filePath,
          room: this.roomName,
          len: this.ytext.length,
        });
        this.scheduleEditorFlush("editor-remote-transaction");
        return;
      }
      this.writeToFile(false, "remote-transaction");
    };
    this.ytext.observe(this.observer);
  }

  private scheduleEditorFlush(reason: string): void {
    if (this.destroyed) return;
    if (this.editorFlushTimer) clearTimeout(this.editorFlushTimer);
    this.editorFlushTimer = setTimeout(() => {
      this.editorFlushTimer = null;
      void this.flushToDisk(reason);
    }, 250);
    trace("file", "editor-flush-scheduled", {
      path: this.filePath,
      room: this.roomName,
      reason,
      len: this.ytext.length,
    });
  }

  /** Write ytext content to vault file (if different) */
  private async writeToFile(force = false, reason = "sync"): Promise<void> {
    const seq = ++this.writeSeq;
    trace("file", "write-queued", {
      path: this.filePath,
      room: this.roomName,
      seq,
      force,
      reason,
      editorBound: this.editorBound,
      len: this.ytext?.length ?? null,
    });
    const run = () => this.writeToFileNow(force, reason, seq);
    this.writeQueue = this.writeQueue.then(run, run);
    await this.writeQueue;
  }

  private async writeToFileNow(force: boolean, reason: string, seq: number): Promise<void> {
    if (this.destroyed) {
      trace("file", "write-skipped", { path: this.filePath, room: this.roomName, seq, reason, cause: "destroyed" });
      return;
    }
    if (this.editorBound && !force) {
      trace("file", "write-skipped", { path: this.filePath, room: this.roomName, seq, reason, cause: "editor-bound" });
      return;
    }
    this.writing = true;
    try {
      const content = this.ytext.toString();
      const file = this.app.vault.getAbstractFileByPath(this.filePath);
      if (!(file instanceof TFile)) {
        trace("file", "write-skipped", { path: this.filePath, room: this.roomName, seq, reason, cause: "missing-file" });
        return;
      }

      let wrote = false;
      beginRemoteApply();
      try {
        await this.app.vault.process(file, (current) => {
          if (current === content) return current;
          wrote = true;
          // Fingerprint exactly what we're about to write so the vault write
          // echo is recognised and dropped deterministically (no timing window).
          this.echo.mark(this.filePath, content);
          trace("file", "write-start", {
            path: this.filePath,
            room: this.roomName,
            seq,
            reason,
            oldLen: current.length,
            newLen: content.length,
          });
          return content;
        });
        if (!wrote) {
          trace("file", "write-skipped", { path: this.filePath, room: this.roomName, seq, reason, cause: "unchanged", len: content.length });
          return;
        }
        trace("file", "write-ok", { path: this.filePath, room: this.roomName, seq, reason, len: content.length });
      } finally {
        endRemoteApply();
      }
    } catch (e) {
      trace("file", "write-error", { path: this.filePath, room: this.roomName, seq, reason, error: e });
      console.error("FileProvider: writeToFile failed", this.filePath, e);
    } finally {
      this.writing = false;
    }
  }

  /** Apply a local file change to ytext (called from vault.on("modify")) */
  applyLocalChange(newContent: string): void {
    if (!this.isInitialized || this.destroyed) return;
    // While bound, yCollab already streams editor edits into ytext — the
    // vault write echo would double-apply, so ignore it here.
    if (this.editorBound) return;
    const old = this.ytext.toString();
    if (old === newContent) return;
    // Staleness guard: the incoming disk content matches something the plugin
    // recently wrote, but ytext has since merged newer remote ops (old !==
    // newContent). Applying it would revert the merge — drop the late echo.
    if (this.echo.isEcho(this.filePath, newContent)) {
      log("loop", "stale echo ignored in applyLocalChange", this.filePath);
      trace("loop", "stale-echo-ignored", { path: this.filePath, room: this.roomName, len: newContent.length });
      return;
    }

    const { start, delCount, insert } = diffRange(old, newContent);
    trace("file", "local-disk-diff", {
      path: this.filePath,
      room: this.roomName,
      oldLen: old.length,
      newLen: newContent.length,
      start,
      delCount,
      insertLen: insert.length,
    });
    this.ydoc.transact(() => {
      if (delCount > 0) this.ytext.delete(start, delCount);
      if (insert.length > 0) this.ytext.insert(start, insert);
    });
  }

  /**
   * Apply a plugin-owned text rewrite as a CRDT edit, then flush it to disk.
   * Unlike vault.on("modify") changes, there is no originating disk event, so
   * headless files need the explicit flush. Editor-bound files also work:
   * yCollab renders the local transaction and this write persists the result.
   */
  async applyProgrammaticChange(newContent: string, reason: string): Promise<boolean> {
    if (this.destroyed || !this.ydoc || !this.ytext) return false;
    const old = this.ytext.toString();
    if (!this.isInitialized && old.length === 0 && newContent.length > 0) {
      trace("file", "programmatic-change-skipped", {
        path: this.filePath,
        room: this.roomName,
        reason,
        cause: "not-initialized-empty-doc",
        newLen: newContent.length,
      });
      return false;
    }
    if (old === newContent) return false;
    trace("file", "programmatic-change", {
      path: this.filePath,
      room: this.roomName,
      reason,
      oldLen: old.length,
      newLen: newContent.length,
    });
    this.applyDiff(old, newContent, reason);
    await this.writeToFile(true, reason);
    return true;
  }

  /** No editor binding in headless mode */
  hasEditor(): boolean {
    return false;
  }

  /**
   * Restore the file to a prior version's text. Applies as a CRDT diff (so it
   * converges to peers and, if this file is the active editor, yCollab updates
   * the view). Saves a pre-restore local backup first. Explicitly flushes to
   * disk even when headless (the observer skips local transactions).
   */
  async restoreFromText(newText: string): Promise<void> {
    if (!this.isInitialized || this.destroyed) return;
    const old = this.ytext.toString();
    if (old === newText) return;
    await this.saveSnapshot(old).catch((e) => console.error("[FileProvider] pre-restore snapshot failed", e));
    this.applyDiff(old, newText, "restore");
    await this.writeToFile(true, "restore");
  }

  private updateUsers(): void {
    if (!this.provider) return;
    const states = this.provider.awareness.getStates();
    const users: ConnectedUser[] = [];
    states.forEach((state: any, clientId: number) => {
      if (clientId !== this.provider.awareness.clientID && state.user) {
        users.push({ clientId, name: state.user.displayName || state.user.name, color: state.user.color, device: state.user.device });
      }
    });
    this.onUsersChange(users);
  }

  /** Apply a diff between two strings as Yjs operations */
  private applyDiff(oldContent: string, newContent: string, origin?: unknown): void {
    const { start, delCount, insert } = diffRange(oldContent, newContent);
    if (delCount > 0 || insert.length > 0) {
      this.ydoc.transact(() => {
        if (delCount > 0) this.ytext.delete(start, delCount);
        if (insert.length > 0) this.ytext.insert(start, insert);
      }, origin);
    }
  }

  /** Current Y.Text content (for transferring/preserving across destroy). */
  getText(): string {
    return this.ytext?.toString() ?? "";
  }

  /** Full Y.Doc state for cloning into another room (rename content-transfer). */
  encodeState(): Uint8Array | null {
    if (!this.ydoc) return null;
    return Y.encodeStateAsUpdate(this.ydoc);
  }

  /**
   * "Never lose stuff" pre-destroy guarantee. Saves the CURRENT content to the
   * local backups/ dir before any delete / rename / large overwrite. The server
   * keeps git history independently; this is the local belt-and-suspenders copy
   * that works offline. No-op for empty docs.
   */
  async flushSnapshot(): Promise<void> {
    if (this.destroyed) return;
    const content = this.getText();
    if (content.length === 0) return;
    await this.saveSnapshot(content).catch((e) => log("delete", "flushSnapshot failed", this.filePath, e));
  }

  /**
   * Move the current content to the local trash before a delete. Distinct from
   * backups/ (pre-overwrite snapshots): trash is keyed by share + path so a
   * deleted note is one click back, retained longer. No-op for empty docs.
   */
  async saveToTrash(): Promise<void> {
    const content = this.getText();
    if (content.length === 0) return;
    await FileProvider.saveTextToTrash(this.app, this.shareId, this.filePath, content);
  }

  /** Save arbitrary text to the local trash store for a path. Used both by a live
   *  FileProvider and by startup tombstone handling before providers exist. */
  static async saveTextToTrash(app: App, shareId: string, fullPath: string, content: string): Promise<void> {
    if (content.length === 0) return;
    const adapter = app.vault.adapter;
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeName = fullPath.replace(/\//g, "__");
    const root = trashDir(app);
    const dir = `${root}/${(shareId || "legacy").replace(/[^A-Za-z0-9_.-]/g, "_")}`;
    await adapter.mkdir(root).catch(() => {});
    await adapter.mkdir(dir).catch(() => {});
    await adapter.write(`${dir}/${safeName}__${ts}.${backupExtension(fullPath)}`, content)
      .catch((e) => log("delete", "saveToTrash failed", fullPath, e));
  }

  /** Save a pre-sync snapshot for disaster recovery */
  private async saveSnapshot(content: string): Promise<void> {
    await FileProvider.saveTextSnapshot(this.app, this.filePath, content);
  }

  /** Save arbitrary text to backups/. Used by pre-overwrite and startup delete
   *  handling when a FileProvider has not been created yet. */
  static async saveTextSnapshot(app: App, fullPath: string, content: string): Promise<void> {
    if (content.length === 0) return;
    const adapter = app.vault.adapter;
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeName = fullPath.replace(/\//g, "__");
    const dir = backupDir(app);
    const snapshotPath = `${dir}/${safeName}__${ts}.${backupExtension(fullPath)}`;

    await adapter.mkdir(dir).catch(() => {});
    await adapter.write(snapshotPath, content);
  }

  /** Normal teardown — preserves IndexedDB for next session */
  destroy(): void {
    this.destroyed = true;
    if (this.editorFlushTimer) {
      clearTimeout(this.editorFlushTimer);
      this.editorFlushTimer = null;
    }
    if (this.observer) {
      this.ytext.unobserve(this.observer);
      this.observer = null;
    }
    if (this.provider) {
      this.provider.destroy();
      this.provider = null;
    }
    if (this.idbProvider) {
      this.idbProvider.destroy();
      this.idbProvider = null;
    }
    if (this.ydoc) {
      this.ydoc.destroy();
      this.ydoc = null as any;
    }
  }

  /** Teardown AND wipe IndexedDB data (call when file is permanently deleted) */
  async destroyAndClearData(): Promise<void> {
    this.destroyed = true;
    if (this.editorFlushTimer) {
      clearTimeout(this.editorFlushTimer);
      this.editorFlushTimer = null;
    }
    if (this.observer) {
      this.ytext.unobserve(this.observer);
      this.observer = null;
    }
    if (this.provider) {
      this.provider.destroy();
      this.provider = null;
    }
    if (this.idbProvider) {
      await this.idbProvider.clearData();
      this.idbProvider.destroy();
      this.idbProvider = null;
    }
    if (this.ydoc) {
      this.ydoc.destroy();
      this.ydoc = null as any;
    }
  }

  /** Newest trashed content for a deleted file (offline fallback for restore). */
  static async readLatestTrash(app: App, shareId: string, fullPath: string): Promise<string | null> {
    const adapter = app.vault.adapter;
    const shareDir = (shareId || "legacy").replace(/[^A-Za-z0-9_.-]/g, "_");
    const dir = `${trashDir(app)}/${shareDir}`;
    const prefix = `${dir}/${fullPath.replace(/\//g, "__")}__`;
    try {
      const listing = await adapter.list(dir);
      let best: string | null = null;
      let bestMtime = -1;
      for (const f of listing.files) {
        if (!f.startsWith(prefix)) continue;
        const stat = await adapter.stat(f);
        if (stat && stat.mtime > bestMtime) { bestMtime = stat.mtime; best = f; }
      }
      return best ? await adapter.read(best) : null;
    } catch {
      return null;
    }
  }

  /**
   * Delete backup snapshots older than maxAgeDays, and trashed deletions older
   * than trashAgeDays (trash is retained longer — it's the "undo a delete" net).
   */
  static async cleanupSnapshots(app: App, maxAgeDays = 7, trashAgeDays = 30): Promise<void> {
    const adapter = app.vault.adapter;
    const sweep = async (dir: string, ageDays: number, recurse: boolean): Promise<void> => {
      try {
        const listing = await adapter.list(dir);
        const cutoff = Date.now() - ageDays * 24 * 60 * 60 * 1000;
        for (const file of listing.files) {
          const stat = await adapter.stat(file);
          if (stat && stat.mtime < cutoff) await adapter.remove(file);
        }
        if (recurse) for (const sub of listing.folders) await sweep(sub, ageDays, false);
      } catch {
        // Dir may not exist yet — that's fine
      }
    };
    await sweep(backupDir(app), maxAgeDays, false);
    await sweep(trashDir(app), trashAgeDays, true); // trash is nested per-share
  }
}

function originName(origin: unknown): string {
  if (origin == null) return "null";
  if (typeof origin === "string") return origin;
  if (typeof origin === "object") return (origin as any).constructor?.name || "object";
  return typeof origin;
}
