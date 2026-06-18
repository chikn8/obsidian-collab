import { ItemView, WorkspaceLeaf, setIcon, Notice } from "obsidian";

export const HISTORY_VIEW_TYPE = "collab-history";

export interface Version {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

export interface DeletedFile {
  relPath: string;
  deletedBy?: string;
  deletedAt?: number;
}

export interface HistoryContext {
  fileName: string;
  list: () => Promise<Version[]>;
  load: (hash: string) => Promise<string | null>;
  restore: (text: string) => Promise<void>;
  currentText: () => string;
  /** Tombstoned files in this share (Phase B "Deleted files" recovery). */
  deletedFiles?: () => DeletedFile[];
  /** Un-delete a tombstoned file; returns true on success. */
  restoreDeleted?: (relPath: string) => Promise<boolean>;
}

/** Version-history side panel: browse server git snapshots, preview, restore. */
export class HistoryView extends ItemView {
  private ctx: HistoryContext | null = null;
  private selected: string | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string { return HISTORY_VIEW_TYPE; }
  getDisplayText(): string { return "Version history"; }
  getIcon(): string { return "history"; }

  async onOpen(): Promise<void> { this.render(); }

  setContext(ctx: HistoryContext | null): void {
    this.ctx = ctx;
    this.selected = null;
    this.render();
  }

  private async render(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("collab-history-view");
    root.createEl("div", { text: this.ctx ? `History — ${this.ctx.fileName}` : "Version history", cls: "collab-history-title" });

    if (!this.ctx) {
      root.createEl("p", { text: "Open a synced note to see its version history.", cls: "collab-comments-empty" });
      return;
    }

    this.renderDeleted(root);

    const listEl = root.createDiv({ cls: "collab-history-list" });
    listEl.createEl("p", { text: "Loading…", cls: "collab-comments-empty" });

    let versions: Version[] = [];
    try { versions = await this.ctx.list(); } catch { /* show empty */ }
    listEl.empty();

    if (versions.length === 0) {
      listEl.createEl("p", { text: "No saved versions yet. History is captured ~every minute while a note is being edited.", cls: "collab-comments-empty" });
      return;
    }

    for (const v of versions) {
      const row = listEl.createDiv({ cls: "collab-history-row" + (this.selected === v.hash ? " selected" : "") });
      const main = row.createDiv({ cls: "collab-history-main" });
      main.createSpan({ text: relTime(v.date), cls: "collab-history-when" });
      main.createSpan({ text: " · " + (v.author || "unknown"), cls: "collab-history-author" });
      row.onclick = () => { this.selected = v.hash; this.render(); };

      if (this.selected === v.hash) {
        const actions = row.createDiv({ cls: "collab-history-actions" });
        const prev = actions.createEl("button", { text: "Preview", cls: "collab-comment-btn" });
        prev.onclick = async (e) => {
          e.stopPropagation();
          const content = await this.ctx!.load(v.hash);
          if (content == null) { new Notice("Couldn't load this version."); return; }
          this.showPreview(root, v, content);
        };
        const restore = actions.createEl("button", { cls: "collab-comment-btn" });
        setIcon(restore, "rotate-ccw"); restore.appendText(" Restore");
        restore.onclick = async (e) => {
          e.stopPropagation();
          const content = await this.ctx!.load(v.hash);
          if (content == null) { new Notice("Couldn't load this version."); return; }
          await this.ctx!.restore(content);
          new Notice("Restored. A pre-restore backup was saved.");
        };
      }
    }
  }

  /** "Deleted files" recovery section — one-click un-delete (Phase B). */
  private renderDeleted(root: HTMLElement): void {
    const ctx = this.ctx;
    if (!ctx?.deletedFiles || !ctx.restoreDeleted) return;
    const deleted = ctx.deletedFiles();
    if (deleted.length === 0) return;

    const section = root.createDiv({ cls: "collab-history-deleted" });
    section.createEl("div", { text: `Deleted files (${deleted.length})`, cls: "collab-history-subtitle" });
    for (const d of deleted) {
      const row = section.createDiv({ cls: "collab-history-row" });
      const main = row.createDiv({ cls: "collab-history-main" });
      const name = d.relPath.split("/").pop() || d.relPath;
      main.createSpan({ text: name, cls: "collab-history-when" });
      const meta = [d.deletedBy ? `by ${d.deletedBy}` : "", d.deletedAt ? relTime(new Date(d.deletedAt).toISOString()) : ""]
        .filter(Boolean).join(" · ");
      if (meta) main.createSpan({ text: " · " + meta, cls: "collab-history-author" });
      const restore = row.createEl("button", { cls: "collab-comment-btn" });
      setIcon(restore, "rotate-ccw"); restore.appendText(" Restore");
      restore.onclick = async (e) => {
        e.stopPropagation();
        restore.disabled = true;
        const ok = await ctx.restoreDeleted!(d.relPath);
        new Notice(ok ? `Restoring "${name}"…` : "Couldn't restore this file.");
        if (ok) setTimeout(() => this.render(), 1200);
        else restore.disabled = false;
      };
    }
  }

  private showPreview(root: HTMLElement, v: Version, content: string): void {
    const existing = root.querySelector(".collab-history-preview");
    existing?.remove();
    const box = root.createDiv({ cls: "collab-history-preview" });
    box.createEl("div", { text: `Preview — ${relTime(v.date)}`, cls: "collab-history-when" });
    box.createEl("pre", { text: content.slice(0, 4000) + (content.length > 4000 ? "\n…" : "") });
  }
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (isNaN(t)) return iso;
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
