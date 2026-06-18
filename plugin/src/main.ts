import { Plugin, TFile, TFolder, MarkdownView, Notice, Platform, debounce } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { SyncManager } from "./collab/SyncManager";
import { FileProvider } from "./collab/FileProvider";
import { InstanceWatch } from "./collab/InstanceWatch";
import { StatusBarWidget } from "./ui/StatusBarWidget";
import { CollabSettingsTab } from "./ui/SettingsTab";
import { collabEditorExtension, getEditorView, bindEditor, unbindEditor, readOnlyExtension } from "./collab/EditorBinding";
import { CommentStore } from "./collab/CommentStore";
import { CommentSession } from "./collab/CommentLayer";
import { PresenceController } from "./collab/Presence";
import { selfSelectionExtension } from "./collab/SelfSelection";
import { CommentsView, COMMENTS_VIEW_TYPE } from "./ui/CommentsView";
import { promptModal } from "./ui/modals";
import { configureDiagnostics, exportDiagnosticBundle, log, err, setDiagnosticLogging, startDiagnosticTrace, trace } from "./utils/log";
import { getJson, postJson } from "./utils/http";
import { ensureIdentityKeys } from "./utils/identity";
import { findMentionedUsers } from "./utils/mentions";
import {
  encodeShareCode,
  decodeShareCode,
  generateShareId,
  deriveRoleKey,
  deriveAdminToken,
  httpBase,
} from "./utils/roomName";
import { HistoryView, HISTORY_VIEW_TYPE, type HistoryContext } from "./ui/HistoryView";
import type { CollabPluginSettings, SyncStatus, ConnectedUser, Share, Role, ShareInvite } from "./types";
import { colorFor, DEFAULT_SETTINGS, LEGACY_SHARE_ID } from "./types";

export default class CollabPlugin extends Plugin {
  settings: CollabPluginSettings = DEFAULT_SETTINGS;
  private statusBar!: StatusBarWidget;
  private instanceWatch: InstanceWatch | null = null;
  private syncManagers: Map<string, SyncManager> = new Map();
  private modifyDebounceMap: Map<string, ReturnType<typeof debounce>> = new Map();
  private debouncedRestart = debounce(() => this.restartShares(), 800, false);

  // Active editor binding state
  private boundView: EditorView | null = null;
  private boundProvider: FileProvider | null = null;
  private boundPath: string | null = null;
  private boundStore: CommentStore | null = null;
  private boundSession: CommentSession | null = null;
  private boundPresence: PresenceController | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    configureDiagnostics({
      app: this.app,
      uid: this.settings.uid,
      debugLogging: this.settings.debugLogging,
      diagnosticLogging: this.settings.diagnosticLogging,
      context: () => this.diagnosticContext(),
    });
    log("load", "starting; uid=", this.settings.uid?.slice(0, 8), "shares=", this.settings.shares.length);

    this.statusBar = new StatusBarWidget(this.addStatusBarItem());
    this.addSettingTab(new CollabSettingsTab(this.app, this));

    // Comments sidebar (first ItemView in the plugin)
    this.registerView(COMMENTS_VIEW_TYPE, (leaf) => new CommentsView(leaf));
    this.addRibbonIcon("message-square", "Collab comments", () => this.openCommentsPanel());
    this.addCommand({ id: "open-comments", name: "Open comments panel", callback: () => this.openCommentsPanel() });
    this.addCommand({
      id: "add-comment-to-selection",
      name: "Add comment to selection",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const canComment =
          !!file &&
          !!this.managerOwning(file.path) &&
          this.boundPath === file.path &&
          !!this.boundView &&
          !this.boundView.state.selection.main.empty;
        if (checking) return canComment;
        if (!canComment || !file) return false;
        trace("comment", "add-command", { path: file.path });
        void this.addCommentForSelection(file, this.app.workspace.getActiveViewOfType(MarkdownView) ?? {});
        return true;
      },
    });

    // Version-history sidebar
    this.registerView(HISTORY_VIEW_TYPE, (leaf) => new HistoryView(leaf));
    this.addCommand({ id: "open-history", name: "Open version history", callback: () => this.openHistoryPanel() });

    // Register the (initially empty) yCollab compartment for the active editor
    this.registerEditorExtension([collabEditorExtension]);

    // Clean up old backup snapshots (>7 days) and trashed deletions (>30 days)
    FileProvider.cleanupSnapshots(this.app, 7, 30).catch(() => {});

    // Warn if the same vault is open in another Obsidian instance (loop risk).
    this.instanceWatch = new InstanceWatch(this.app, (id) => this.registerInterval(id));
    this.instanceWatch.start().catch(() => {});

    await this.startAllShares();
    // Bind the already-open editor (if any). Providers connect async, so the
    // retry loop in bindActiveEditor waits for the owning provider to be ready.
    void this.handleActiveLeafChange();

    // Vault events — routed to every manager (each ignores paths outside its folder)
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        trace("vault", "create", { path: (file as any).path, kind: file instanceof TFile ? "file" : file instanceof TFolder ? "folder" : "other" });
        if (file instanceof TFile) this.eachManager((m) => m.onFileCreate(file));
      })
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile)) return;
        trace("vault", "modify", { path: file.path, size: file.stat?.size, mtime: file.stat?.mtime });
        let fn = this.modifyDebounceMap.get(file.path);
        if (!fn) {
          fn = debounce((f: TFile) => this.eachManager((m) => m.onFileModify(f)), 50, true);
          this.modifyDebounceMap.set(file.path, fn);
        }
        fn(file);
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        trace("vault", "delete", { path: (file as any).path, kind: file instanceof TFile ? "file" : file instanceof TFolder ? "folder" : "other" });
        if (file instanceof TFile) this.eachManager((m) => m.onFileDelete(file));
        // Obsidian may fire only ONE folder-delete event (no per-child events on
        // some platforms) — tombstone everything under the folder as a backstop.
        else if (file instanceof TFolder) this.eachManager((m) => m.onFolderDelete(file.path));
        this.modifyDebounceMap.delete((file as TFile).path);
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        trace("vault", "rename", { oldPath, newPath: (file as any).path, kind: file instanceof TFile ? "file" : file instanceof TFolder ? "folder" : "other" });
        if (file instanceof TFile) this.eachManager((m) => m.onFileRename(file, oldPath));
        // A folder move fires ONE event for the folder (no per-child renames), so
        // re-derive each descendant file's rename to preserve content + lineage.
        else if (file instanceof TFolder) this.eachManager((m) => m.onFolderRename(file, oldPath));
        this.modifyDebounceMap.delete(oldPath);
      })
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => void this.handleActiveLeafChange())
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.eachManager((m) => m.refreshPresenceUi()))
    );

    // File/folder context-menu
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof TFolder) {
          menu.addItem((item) =>
            item
              .setTitle("Share this folder (collab)")
              .setIcon("users")
              .onClick(() => this.shareFolderInteractive(file.path))
          );
        } else if (file instanceof TFile && this.managerOwning(file.path)) {
          menu.addItem((item) =>
            item.setTitle("Version history (collab)").setIcon("history").onClick(() => this.openHistoryPanel())
          );
        }
      })
    );

    // Editor context-menu: "Add comment" on a selection in a synced file
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, info) => {
        const file = (info as any)?.file as TFile | undefined;
        if (!file || !this.managerOwning(file.path)) return;
        if (!editor.getSelection()) return;
        menu.addItem((item) =>
          item.setTitle("Add comment").setIcon("message-square").onClick(() => this.addCommentForSelection(file, info))
        );
      })
    );

    // Deep link: obsidian://collab-add?code=...
    this.registerObsidianProtocolHandler("collab-add", async (params) => {
      if (params.code) await this.addShareFromCodeInteractive(params.code);
    });

    // Commands
    this.addCommand({
      id: "share-folder",
      name: "Share a folder…",
      callback: () => this.shareFolderInteractive(),
    });
    this.addCommand({
      id: "add-shared-folder",
      name: "Add a shared folder (paste code)…",
      callback: () => this.addShareFromCodeInteractive(),
    });
    this.addCommand({
      id: "force-resync",
      name: "Force re-sync all folders",
      callback: async () => {
        await this.stopAllShares();
        await this.startAllShares();
      },
    });
    this.addCommand({
      id: "reconnect",
      name: "Reconnect now (all folders)",
      callback: () => {
        this.eachManager((m) => m.reconnect());
        new Notice("Reconnecting…");
        log("reconnect", "manual reconnect of", this.syncManagers.size, "shares");
      },
    });
    this.addCommand({
      id: "start-diagnostic-trace",
      name: "Start collab diagnostic trace (2 minutes)",
      callback: () => this.startDiagnosticTraceInteractive(),
    });
    this.addCommand({
      id: "export-diagnostic-bundle",
      name: "Export collab diagnostic bundle",
      callback: () => this.exportDiagnosticBundleInteractive(),
    });

    console.log("Obsidian Collab plugin loaded (multi-share mode)");
  }

  // ── Share lifecycle ────────────────────────────────────────────

  startDiagnosticTraceInteractive(): void {
    const path = startDiagnosticTrace(2 * 60_000);
    new Notice(`Collab diagnostic trace started: ${path}`, 8000);
  }

  async exportDiagnosticBundleInteractive(): Promise<void> {
    try {
      const path = await exportDiagnosticBundle();
      new Notice(`Collab diagnostic bundle written: ${path}`, 10000);
    } catch (e) {
      err("diag", e);
      new Notice("Could not export collab diagnostic bundle.");
    }
  }

  private diagnosticContext(): Record<string, unknown> {
    const roles = this.settings.shares.reduce<Record<string, number>>((acc, share) => {
      const role = share.role || "editor";
      acc[role] = (acc[role] || 0) + 1;
      return acc;
    }, {});
    return {
      plugin: {
        id: this.manifest.id,
        version: this.manifest.version,
      },
      platform: {
        mobile: Platform.isMobile,
        desktop: Platform.isDesktop,
        mobileApp: Platform.isMobileApp,
        desktopApp: Platform.isDesktopApp,
        ios: Platform.isIosApp,
        android: Platform.isAndroidApp,
        phone: Platform.isPhone,
        tablet: Platform.isTablet,
      },
      settings: {
        shareCount: this.settings.shares.length,
        legacyShareCount: this.settings.shares.filter((s) => s.legacy).length,
        roles,
        ntfyConfigured: !!this.settings.ntfyTopic,
        customCursorColor: !!this.settings.cursorColor,
      },
      runtime: {
        managerCount: this.syncManagers.size,
        boundPath: this.boundPath || "",
        boundProviderReady: this.boundProvider?.isReady() ?? false,
        boundHasPresence: !!this.boundPresence,
        pendingModifyDebounces: this.modifyDebounceMap.size,
      },
    };
  }

  private async startAllShares(): Promise<void> {
    for (const share of this.settings.shares) await this.startShare(share);
  }

  private async startShare(share: Share): Promise<void> {
    if (this.syncManagers.has(share.id)) return;
    const m = new SyncManager(
      this.app,
      this.settings,
      share,
      (status: SyncStatus, fileCount: number, pending: number) =>
        this.statusBar.setShare(share.id, { label: share.label, status, fileCount, pending }),
      (_users: ConnectedUser[]) => {}
    );
    this.syncManagers.set(share.id, m);
    await m.start();
    log("share", "started", share.legacy ? "legacy" : share.id, "->", share.localFolder);
  }

  private async stopShare(id: string): Promise<void> {
    const m = this.syncManagers.get(id);
    if (m) {
      await m.destroy();
      this.syncManagers.delete(id);
    }
    this.statusBar.removeShare(id);
  }

  private async stopAllShares(): Promise<void> {
    for (const id of Array.from(this.syncManagers.keys())) await this.stopShare(id);
  }

  private async restartShares(): Promise<void> {
    await this.stopAllShares();
    await this.startAllShares();
  }

  private eachManager(fn: (m: SyncManager) => void | Promise<void>): void {
    for (const m of this.syncManagers.values()) {
      // Vault handlers are fire-and-forget; swallow async rejections so a
      // single share's error never surfaces as an unhandled promise rejection.
      try {
        const r = fn(m) as unknown;
        if (r instanceof Promise) r.catch((e) => err("vault", e));
      } catch (e) {
        err("vault", e);
      }
    }
  }

  // ── Active editor binding (perf: yCollab) ──────────────────────

  private activeFocusedFile(): TFile | null {
    const activeView = (this.app.workspace as any).activeLeaf?.view as any;
    return activeView?.file instanceof TFile ? activeView.file : null;
  }

  private async handleActiveLeafChange(): Promise<void> {
    // Presence follows the actively focused file view (Markdown, Canvas, etc.).
    // Editor binding still only attaches to Markdown's CodeMirror instance.
    const activeFile = this.activeFocusedFile();
    const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const markdownFile = markdownView?.file ?? null;
    this.eachManager((m) => m.setPresence(activeFile));
    await this.bindActiveEditor(markdownFile, 0);
    // Keep an open history panel in sync with the active file.
    this.getHistoryView()?.setContext(this.buildHistoryContext());
  }

  private async bindActiveEditor(activeFile: TFile | null, attempt: number): Promise<void> {
    // Ignore stale retries fired after the user already switched files.
    if (attempt > 0 && (this.app.workspace.getActiveFile()?.path ?? null) !== (activeFile?.path ?? null)) {
      return;
    }
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const ev = view ? getEditorView(view) : null;
    const path = activeFile?.path ?? null;
    trace("bind", "active-leaf", { path, attempt, hasEditorView: !!ev });

    // Unbind the previous editor if we've moved away from it
    if (this.boundView && (this.boundPath !== path || this.boundView !== ev)) {
      trace("bind", "unbind-start", { oldPath: this.boundPath, nextPath: path, sameView: this.boundView === ev });
      this.boundSession?.detach();
      this.boundPresence?.stop();
      try { unbindEditor(this.boundView); } catch { /* view may be gone */ }
      await this.boundProvider?.setEditorBound(false);
      trace("bind", "unbind-done", { oldPath: this.boundPath, nextPath: path });
      this.boundView = null;
      this.boundProvider = null;
      this.boundPath = null;
      this.boundStore = null;
      this.boundSession = null;
      this.boundPresence = null;
    }

    if (!ev || !path || !activeFile) { this.refreshCommentsContext(); return; }
    if (this.boundPath === path) return; // already bound

    // Find the provider owning this file
    let provider: FileProvider | null = null;
    for (const m of this.syncManagers.values()) {
      provider = m.getFileProvider(path);
      if (provider) break;
    }
    if (!provider) { this.refreshCommentsContext(); return; } // not a synced file

    if (!provider.isReady()) {
      trace("bind", "provider-not-ready", { path, attempt });
      // Provider still connecting/seeding — retry (headless still works meanwhile).
      // ~6s budget covers a cold WebSocket connect + initial sync.
      if (attempt < 20) setTimeout(() => void this.bindActiveEditor(activeFile, attempt + 1), 300);
      return;
    }

    const ytext = provider.getYText();
    const awareness = provider.getAwareness();
    if (!ytext || !awareness) return;

    const store = new CommentStore(provider.getDoc());
    const session = new CommentSession(store, (id) => this.openThread(id));

    // Presence facepile (needs the owning share's manifest awareness)
    const manager = this.managerOwning(path);
    const manifestAwareness = manager?.getManifestAwareness();
    const relPath = manager ? manager.toRel(path) : path;
    const presence =
      manifestAwareness && manager
        ? new PresenceController(ev, provider.getDoc(), manifestAwareness, awareness, relPath)
        : null;

    const role = manager?.role || "editor";
    const selfColor = this.settings.cursorColor || colorFor(this.settings.uid || this.settings.displayName);
    const extras = [session.extension(), selfSelectionExtension({ name: this.settings.displayName || "You", color: selfColor })];
    if (presence) extras.push(presence.extension(Platform.isMobile));
    if (role !== "editor") extras.push(readOnlyExtension());

    await provider.setEditorBound(true);
    bindEditor(ev, ytext, awareness, extras);
    session.attach(ev);
    presence?.start();

    this.boundView = ev;
    this.boundProvider = provider;
    this.boundPath = path;
    this.boundStore = store;
    this.boundSession = session;
    this.boundPresence = presence;
    this.refreshCommentsContext();
    trace("bind", "bound", { path, role, hasPresence: !!presence, comments: store.openCount() });
    log("bind", "bound editor", path, "comments=", store.openCount());
  }

  // ── Comments wiring ─────────────────────────────────────────────

  private getCommentsView(): CommentsView | null {
    const leaves = this.app.workspace.getLeavesOfType(COMMENTS_VIEW_TYPE);
    return (leaves[0]?.view as CommentsView) ?? null;
  }

  private async openCommentsPanel(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(COMMENTS_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false)!;
      await leaf.setViewState({ type: COMMENTS_VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    this.refreshCommentsContext();
  }

  private refreshCommentsContext(): void {
    const view = this.getCommentsView();
    if (!view) return;
    if (this.boundStore && this.boundPath) {
      const fileName = this.boundPath.split("/").pop() || this.boundPath;
      view.setContext({
        store: this.boundStore,
        session: this.boundSession,
        fileName,
        me: { uid: this.settings.uid, name: this.settings.displayName },
        now: () => Date.now(),
        mentionUsers: () => this.managerOwning(this.boundPath || "")?.roster() ?? [],
        notifyFromText: (text) => this.notifyMentionsInText(text, fileName, this.boundPath || ""),
      });
    } else {
      view.setContext(null);
    }
  }

  private openThread(threadId: string): void {
    this.boundSession?.reveal(threadId);
    this.openCommentsPanel();
  }

  private managerOwning(path: string): SyncManager | null {
    for (const m of this.syncManagers.values()) if (m.isInLinkedFolder(path)) return m;
    return null;
  }

  /** Detect "@Name" mentions of collaborators in `text` and push them a notification. */
  private notifyMentionsInText(text: string, fileName: string, filePath: string): void {
    if (!text.includes("@") || !this.boundPath) return;
    const m = this.managerOwning(this.boundPath);
    if (!m) return;
    for (const c of findMentionedUsers(text, m.roster())) {
      m.sendMention(c.uid, `${this.settings.displayName} mentioned you in ${fileName}`, text.slice(0, 300), filePath);
      log("mention", "notified", c.name, c.uid);
    }
  }

  // ── Version history wiring ──────────────────────────────────────

  private getHistoryView(): HistoryView | null {
    return (this.app.workspace.getLeavesOfType(HISTORY_VIEW_TYPE)[0]?.view as HistoryView) ?? null;
  }

  private async openHistoryPanel(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(HISTORY_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false)!;
      await leaf.setViewState({ type: HISTORY_VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    this.getHistoryView()?.setContext(this.buildHistoryContext());
  }

  private buildHistoryContext(): HistoryContext | null {
    const file = this.activeFocusedFile();
    if (!file) return null;
    const m = this.managerOwning(file.path);
    if (!m) return null;
    const share = this.settings.shares.find((s) => s.id === m.shareId);
    if (!share) return null;

    const base = httpBase(this.settings.serverUrl);
    const relPath = m.toRel(file.path);
    const histShareId = share.legacy ? "legacy" : share.id;
    const identityQ = !share.legacy && share.inviteId && this.settings.identityPublicKey && this.settings.identitySignature
      ? `&uid=${encodeURIComponent(this.settings.uid)}&identityKey=${encodeURIComponent(this.settings.identityPublicKey)}&identitySig=${encodeURIComponent(this.settings.identitySignature)}`
      : "";
    const roleQ = share.legacy
      ? ""
      : `&role=${share.role || "editor"}&epoch=${share.epoch ?? 1}${share.inviteId ? `&invite=${encodeURIComponent(share.inviteId)}` : ""}${share.expiresAt ? `&exp=${share.expiresAt}` : ""}${identityQ}`;
    const token = async (): Promise<string | null> =>
      share.legacy ? (this.settings.serverPassword || null) : share.key;

    return {
      fileName: file.name,
      list: async () => {
        const t = await token();
        if (!t) return [];
        try {
          const r = await getJson(`${base}/history?share=${encodeURIComponent(histShareId)}&path=${encodeURIComponent(relPath)}&token=${encodeURIComponent(t)}${roleQ}`);
          if (!r.ok) return [];
          return (r.body as any)?.versions || [];
        } catch (e) { err("history", e); return []; }
      },
      load: async (hash: string) => {
        const t = await token();
        if (!t) return null;
        try {
          const r = await getJson(`${base}/version?share=${encodeURIComponent(histShareId)}&path=${encodeURIComponent(relPath)}&hash=${encodeURIComponent(hash)}&token=${encodeURIComponent(t)}${roleQ}`);
          if (!r.ok) return null;
          return (r.body as any)?.content ?? null;
        } catch (e) { err("history", e); return null; }
      },
      restore: async (text: string) => {
        if (m.role !== "editor") {
          new Notice("This share is read-only on this device.");
          return;
        }
        const fp = m.getFileProvider(file.path);
        if (fp) await fp.restoreFromText(text);
        else new Notice("Open the note before restoring.");
      },
      currentText: () => m.getFileProvider(file.path)?.getYText()?.toString() || "",
      deletedFiles: () => m.listDeletedFiles(),
      restoreDeleted: (relPath: string) => m.restoreDeletedFile(relPath),
    };
  }

  private async addCommentForSelection(file: TFile, info: any): Promise<void> {
    const m = this.managerOwning(file.path);
    const fp = m?.getFileProvider(file.path);
    if (m && m.role !== "editor") { new Notice("This share is read-only on this device."); return; }
    if (!fp || !fp.isReady()) { new Notice("This note is still syncing — try again in a moment."); return; }

    const ev = getEditorView(info) || (this.boundPath === file.path ? this.boundView : null);
    if (!ev) { new Notice("Open the note in the editor to comment."); return; }
    const sel = ev.state.selection.main;
    const from = Math.min(sel.from, sel.to);
    const to = Math.max(sel.from, sel.to);
    if (to <= from) { new Notice("Select some text to comment on."); return; }
    const quote = ev.state.doc.sliceString(from, to).slice(0, 200);

    const res = await promptModal(this.app, {
      title: "Add comment",
      cta: "Comment",
      fields: [{
        key: "text",
        label: `On “${quote.slice(0, 40)}${quote.length > 40 ? "…" : ""}”`,
        placeholder: "Your comment…",
        mentionUsers: this.managerOwning(file.path)?.roster() ?? [],
      }],
    });
    if (!res || !res.text.trim()) return;

    const store = this.boundPath === file.path && this.boundStore ? this.boundStore : new CommentStore(fp.getDoc());
    store.addThread({
      from, to, quote,
      authorUid: this.settings.uid,
      authorName: this.settings.displayName,
      text: res.text.trim(),
      at: Date.now(),
    });
    this.notifyMentionsInText(res.text.trim(), file.name, file.path);
    await this.openCommentsPanel();
  }

  // ── Share creation / joining ───────────────────────────────────

  /** Generate a role-scoped share code using ownerKey, or legacy local-HMAC fallback. */
  async generateShareCode(share: Share, role: Role): Promise<string | null> {
    if (share.legacy) return null;
    const epoch = share.epoch ?? 1;
    if (role === (share.role || "editor")) {
      return encodeShareCode(this.settings.serverUrl, share.id, share.key, role, epoch, undefined, undefined, share.label);
    }

    if (share.ownerKey) {
      try {
        const res = await postJson<{ key: string; role: Role; epoch: number }>(
          `${httpBase(this.settings.serverUrl)}/share/link?share=${encodeURIComponent(share.id)}&role=${encodeURIComponent(role)}&epoch=${epoch}`,
          undefined,
          bearerHeaders(share.ownerKey)
        );
        if (res.ok && res.body?.key) {
          return encodeShareCode(this.settings.serverUrl, share.id, res.body.key, res.body.role, res.body.epoch, undefined, undefined, share.label);
        }
      } catch (e) {
        err("share", "server link mint failed", e);
      }
      new Notice("Could not create that share link on the server.");
      return null;
    }

    if (this.settings.serverSecret) {
      const key = await deriveRoleKey(this.settings.serverSecret, share.id, role, epoch);
      return encodeShareCode(this.settings.serverUrl, share.id, key, role, epoch, undefined, undefined, share.label);
    }

    new Notice("This device does not have owner access for that share.");
    return null;
  }

  async generateShareInviteCode(share: Share, role: Role, recipient: string, expiresAt?: number): Promise<string | null> {
    if (share.legacy) {
      new Notice("Invite links require a non-legacy share.");
      return null;
    }
    if (!share.ownerKey) {
      new Notice("This device does not have owner access for that share.");
      return null;
    }

    const epoch = share.epoch ?? 1;
    try {
      const res = await postJson<{
        id: string;
        inviteId: string;
        key: string;
        role: Role;
        epoch: number;
        recipient?: string;
        expiresAt?: number;
        createdAt?: number;
      }>(
        `${httpBase(this.settings.serverUrl)}/share/invite?share=${encodeURIComponent(share.id)}&role=${encodeURIComponent(role)}&epoch=${epoch}`,
        { recipient, expiresAt },
        bearerHeaders(share.ownerKey)
      );
      if (!res.ok || !res.body?.key || !res.body.inviteId) {
        new Notice("Could not create that invite on the server.");
        return null;
      }

      const invite: ShareInvite = {
        id: res.body.inviteId,
        key: res.body.key,
        role: res.body.role,
        recipient: res.body.recipient || recipient || undefined,
        createdAt: res.body.createdAt,
        expiresAt: res.body.expiresAt,
      };
      share.invites = [invite, ...(share.invites || []).filter((i) => i.id !== invite.id)].slice(0, 50);
      await this.persist();
      return encodeShareCode(
        this.settings.serverUrl,
        share.id,
        res.body.key,
        res.body.role,
        res.body.epoch,
        res.body.inviteId,
        res.body.expiresAt,
        share.label
      );
    } catch (e) {
      err("share", "server invite mint failed", e);
      new Notice("Invite request failed.");
      return null;
    }
  }

  async revokeShareInvite(share: Share, invite: ShareInvite): Promise<boolean> {
    if (!share.ownerKey) {
      new Notice("This device does not have owner access for that share.");
      return false;
    }
    try {
      const res = await postJson<{ ok: boolean; revokedAt?: number; closedConnections?: number }>(
        `${httpBase(this.settings.serverUrl)}/share/invite/revoke?share=${encodeURIComponent(share.id)}&invite=${encodeURIComponent(invite.id)}&epoch=${share.epoch ?? 1}`,
        undefined,
        bearerHeaders(share.ownerKey)
      );
      if (!res.ok) {
        new Notice("Could not revoke that invite.");
        return false;
      }
      invite.revokedAt = res.body?.revokedAt || Date.now();
      await this.persist();
      new Notice(`Invite revoked${res.body?.closedConnections ? `; closed ${res.body.closedConnections} connection(s)` : ""}.`);
      return true;
    } catch (e) {
      err("revoke", e);
      new Notice("Invite revoke request failed.");
      return false;
    }
  }

  /** Revoke ALL outstanding codes for a share by bumping its epoch. */
  async revokeShareAccess(share: Share): Promise<boolean> {
    if (share.legacy) {
      new Notice("Can't revoke legacy shares.");
      return false;
    }

    if (share.ownerKey) {
      try {
        const res = await postJson<{ epoch: number; key: string; ownerKey: string; closedConnections?: number }>(
          `${httpBase(this.settings.serverUrl)}/share/revoke?share=${encodeURIComponent(share.id)}&epoch=${share.epoch ?? 1}`,
          undefined,
          bearerHeaders(share.ownerKey)
        );
        if (!res.ok || !res.body?.key || !res.body.ownerKey) {
          new Notice("Revoke failed on the server.");
          return false;
        }
        share.epoch = res.body.epoch;
        share.role = "editor";
        share.key = res.body.key;
        share.ownerKey = res.body.ownerKey;
        const revokedAt = Date.now();
        for (const invite of share.invites || []) {
          if (!invite.revokedAt) invite.revokedAt = revokedAt;
        }
        await this.persist();
        await this.stopShare(share.id);
        await this.startShare(share);
        log("revoke", "share", share.id, "-> epoch", share.epoch, "closed=", res.body.closedConnections ?? 0);
        new Notice("Access revoked. Old links no longer work — re-share to invite again.");
        return true;
      } catch (e) {
        err("revoke", e);
        new Notice("Revoke request failed.");
        return false;
      }
    }

    if (!this.settings.serverSecret) {
      new Notice("Can't revoke this share from this device.");
      return false;
    }

    const newEpoch = (share.epoch ?? 1) + 1;
    const token = await deriveAdminToken(this.settings.serverSecret, share.id, newEpoch);
    try {
      const res = await postJson(`${httpBase(this.settings.serverUrl)}/admin/revoke?share=${encodeURIComponent(share.id)}&epoch=${newEpoch}&token=${encodeURIComponent(token)}`);
      if (!res.ok) { new Notice("Revoke failed on the server."); return false; }
    } catch (e) {
      err("revoke", e); new Notice("Revoke request failed."); return false;
    }
    // Re-key ourselves to the new epoch (we're the editor/owner) and restart.
    share.epoch = newEpoch;
    share.role = share.role || "editor";
    share.key = await deriveRoleKey(this.settings.serverSecret, share.id, share.role as Role, newEpoch);
    const revokedAt = Date.now();
    for (const invite of share.invites || []) {
      if (!invite.revokedAt) invite.revokedAt = revokedAt;
    }
    await this.persist();
    await this.stopShare(share.id);
    await this.startShare(share);
    log("revoke", "share", share.id, "-> epoch", newEpoch);
    new Notice("Access revoked. Old links no longer work — re-share to invite again.");
    return true;
  }

  private folderOverlaps(path: string): Share | null {
    for (const s of this.settings.shares) {
      const a = s.localFolder;
      if (path === a || path.startsWith(a + "/") || a.startsWith(path + "/")) return s;
    }
    return null;
  }

  async shareFolderInteractive(presetFolder?: string): Promise<void> {
    if (!this.settings.shareMintToken && !this.settings.serverSecret) {
      new Notice("Set the Share admin token in settings first — it's needed to create shares.");
      return;
    }
    const res = await promptModal(this.app, {
      title: "Share a folder",
      cta: "Create share",
      fields: [
        { key: "folder", label: "Vault folder to share", placeholder: "Path/To/Folder", value: presetFolder ?? "" },
        { key: "label", label: "Label (shown to you)", placeholder: "e.g. Game Dev w/ Saket" },
      ],
    });
    if (!res || !res.folder.trim()) return;
    const folder = res.folder.trim().replace(/\/+$/, "");

    const overlap = this.folderOverlaps(folder);
    if (overlap) {
      new Notice(`That folder overlaps an existing share ("${overlap.label}").`);
      return;
    }
    await this.ensureFolder(folder);

    const minted = await this.mintShare();
    if (!minted) return;
    const share: Share = {
      id: minted.id,
      key: minted.key,
      role: "editor",
      epoch: minted.epoch,
      ownerKey: minted.ownerKey,
      label: res.label.trim() || folder.split("/").pop() || folder,
      localFolder: folder,
    };
    this.settings.shares.push(share);
    await this.persist();
    await this.startShare(share);

    // Default to copying an EDITOR link; viewer links are available in settings.
    const code = await this.generateShareCode(share, "editor");
    let copied = false;
    if (code) {
      try { await navigator.clipboard.writeText(code); copied = true; } catch { /* clipboard may be unavailable on mobile */ }
    }
    new Notice(copied
      ? `Share created — editor link copied. For a view-only link, use “Copy link” in settings.`
      : `Share created. Copy the editor link from settings (clipboard unavailable here).`);
  }

  private async mintShare(): Promise<{ id: string; key: string; epoch: number; ownerKey?: string } | null> {
    if (this.settings.shareMintToken) {
      try {
        const res = await postJson<{ id: string; key: string; epoch: number; ownerKey?: string }>(
          `${httpBase(this.settings.serverUrl)}/share/create`,
          undefined,
          bearerHeaders(this.settings.shareMintToken)
        );
        if (res.ok && res.body?.id && res.body.key) {
          return {
            id: res.body.id,
            key: res.body.key,
            epoch: res.body.epoch ?? 1,
            ownerKey: res.body.ownerKey,
          };
        }
        new Notice("Share creation was rejected by the server.");
      } catch (e) {
        err("share", "server mint failed", e);
        new Notice("Share creation request failed.");
      }
      if (!this.settings.serverSecret) return null;
    }

    if (this.settings.serverSecret) {
      const id = generateShareId();
      const epoch = 1;
      const key = await deriveRoleKey(this.settings.serverSecret, id, "editor", epoch);
      return { id, key, epoch };
    }

    return null;
  }

  async addShareFromCodeInteractive(presetCode = ""): Promise<void> {
    const decoded = presetCode ? decodeShareCode(presetCode) : null;
    const suggestedFolder = decoded ? this.suggestJoinFolder(decoded.l, decoded.id) : "";
    const suggestedLabel = decoded?.l || "";
    const res = await promptModal(this.app, {
      title: "Join a shared folder",
      cta: "Join",
      fields: [
        { key: "code", label: "Share code", placeholder: "Paste the code you were sent", value: presetCode },
        { key: "folder", label: "Local folder to sync into", placeholder: "Shared/Team Notes", value: suggestedFolder },
        { key: "label", label: "Label (shown to you)", placeholder: "e.g. Team Notes", value: suggestedLabel },
      ],
    });
    if (!res || !res.code.trim()) return;
    await this.addShareFromCode(res.code.trim(), res.folder.trim(), res.label.trim());
  }

  async addShareFromCode(code: string, localFolder?: string, label?: string): Promise<void> {
    const decoded = decodeShareCode(code);
    if (!decoded) {
      new Notice("Invalid share code.");
      return;
    }
    if (this.settings.shares.some((s) => s.id === decoded.id)) {
      new Notice("You already have this shared folder.");
      return;
    }
    // Adopt the server URL from the code if we don't have one yet
    if (!this.settings.serverUrl || this.settings.serverUrl === DEFAULT_SETTINGS.serverUrl) {
      this.settings.serverUrl = decoded.s;
    }
    const folder = (localFolder?.trim() || this.suggestJoinFolder(decoded.l, decoded.id)).replace(/\/+$/, "");
    const overlap = this.folderOverlaps(folder);
    if (overlap) {
      new Notice(`That folder overlaps an existing share ("${overlap.label}").`);
      return;
    }
    await this.ensureFolder(folder);

    const share: Share = {
      id: decoded.id,
      key: decoded.k,
      role: decoded.r,
      epoch: decoded.e,
      inviteId: decoded.i,
      expiresAt: decoded.x,
      label: label?.trim() || decoded.l?.trim() || folder.split("/").pop() || folder,
      localFolder: folder,
    };
    this.settings.shares.push(share);
    await this.persist();
    await this.startShare(share);
    log("share", "joined", share.id, "role=", share.role || "editor");
    new Notice(`Joined shared folder → ${folder}${share.role && share.role !== "editor" ? ` (${share.role})` : ""}`);
  }

  private suggestJoinFolder(label: string | undefined, id: string): string {
    const baseName = safeFolderSegment(label || "Collab share");
    const base = `Shared/${baseName}`;
    let candidate = base;
    let i = 2;
    while (this.folderOverlaps(candidate) || this.app.vault.getAbstractFileByPath(candidate)) {
      candidate = `${base} ${i++}`;
    }
    return candidate;
  }

  async removeShare(id: string): Promise<void> {
    await this.stopShare(id);
    this.settings.shares = this.settings.shares.filter((s) => s.id !== id);
    await this.persist();
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

  async onunload(): Promise<void> {
    this.boundSession?.detach();
    this.boundPresence?.stop();
    if (this.boundView) {
      try { unbindEditor(this.boundView); } catch { /* ignore */ }
      await this.boundProvider?.setEditorBound(false);
    }
    await this.instanceWatch?.stop();
    await this.stopAllShares();
    console.log("Obsidian Collab plugin unloaded");
  }

  // ── Settings (with migration) ──────────────────────────────────

  async loadSettings(): Promise<void> {
    const raw: any = (await this.loadData()) || {};
    // Migrate the old single-folder shape → a legacy share (zero disruption).
    if (raw.shares === undefined && (raw.linkedFolder !== undefined || raw.password !== undefined)) {
      this.settings = {
        serverUrl: raw.serverUrl ?? DEFAULT_SETTINGS.serverUrl,
        serverPassword: raw.password ?? "",
        shareMintToken: raw.shareMintToken ?? "",
        serverSecret: "",
        displayName: raw.displayName ?? DEFAULT_SETTINGS.displayName,
        cursorColor: raw.cursorColor ?? DEFAULT_SETTINGS.cursorColor,
        uid: raw.uid ?? "",
        identityPublicKey: raw.identityPublicKey ?? "",
        identityPrivateKey: raw.identityPrivateKey ?? "",
        identitySignature: raw.identitySignature ?? "",
        ntfyTopic: raw.ntfyTopic ?? "",
        debugLogging: raw.debugLogging ?? DEFAULT_SETTINGS.debugLogging,
        diagnosticLogging: raw.diagnosticLogging ?? DEFAULT_SETTINGS.diagnosticLogging,
        shares: raw.linkedFolder
          ? [{ id: LEGACY_SHARE_ID, key: "", label: "Synced Obsidian", localFolder: raw.linkedFolder, legacy: true }]
          : [],
      };
      await this.persist();
    } else {
      this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);
    }
    // Stable per-install identity (joins facepile<->cursor; see types.ts).
    if (!this.settings.uid) {
      this.settings.uid =
        (globalThis.crypto?.randomUUID?.() as string) || generateShareId(24);
      await this.persist();
    }
    const identity = await ensureIdentityKeys({
      publicKey: this.settings.identityPublicKey || raw.identityPublicKey,
      privateKey: this.settings.identityPrivateKey || raw.identityPrivateKey,
      signature: this.settings.identitySignature || raw.identitySignature,
    }, this.settings.uid);
    this.settings.identityPublicKey = identity.publicKey;
    this.settings.identityPrivateKey = identity.privateKey;
    this.settings.identitySignature = identity.signature;
    await this.persist();
  }

  /** Persist without touching live sync. */
  private async persist(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Called by the settings UI. `restart` debounces a full re-sync for connection changes. */
  async saveSettings(restart = true): Promise<void> {
    configureDiagnostics({
      app: this.app,
      uid: this.settings.uid,
      debugLogging: this.settings.debugLogging,
      diagnosticLogging: this.settings.diagnosticLogging,
      context: () => this.diagnosticContext(),
    });
    setDiagnosticLogging(this.settings.diagnosticLogging);
    await this.persist();
    if (restart) this.debouncedRestart();
  }
}

function bearerHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function safeFolderSegment(value: string): string {
  const clean = value
    .replace(/[\\/:*?"<>|#[\]^]/g, " ")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return clean || "Collab share";
}
