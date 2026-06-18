import { ItemView, WorkspaceLeaf, setIcon, Notice } from "obsidian";
import { applyRestoreHunk, buildInlineDiff, buildRestoreHunks, type DiffRow, type RestoreHunk } from "../utils/lineDiff";
import type { ConflictFile } from "../utils/manifestLogic";

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
  /** Visible conflict copies retained for manual review. */
  conflictFiles?: () => ConflictFile[];
  /** Open a conflict copy in Obsidian; returns true on success. */
  openConflict?: (relPath: string) => Promise<boolean>;
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
      root.createEl("p", { text: "Open a synced file to see its version history.", cls: "collab-comments-empty" });
      return;
    }

    this.renderDeleted(root);
    this.renderConflicts(root);

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
        const diff = actions.createEl("button", { text: "Diff", cls: "collab-comment-btn" });
        diff.onclick = async (e) => {
          e.stopPropagation();
          const content = await this.ctx!.load(v.hash);
          if (content == null) { new Notice("Couldn't load this version."); return; }
          this.showDiff(root, v, content, "inline");
        };
        const sideDiff = actions.createEl("button", { text: "Side by side", cls: "collab-comment-btn" });
        sideDiff.onclick = async (e) => {
          e.stopPropagation();
          const content = await this.ctx!.load(v.hash);
          if (content == null) { new Notice("Couldn't load this version."); return; }
          this.showDiff(root, v, content, "side");
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

  private renderConflicts(root: HTMLElement): void {
    const ctx = this.ctx;
    if (!ctx?.conflictFiles || !ctx.openConflict) return;
    const conflicts = ctx.conflictFiles();
    if (conflicts.length === 0) return;

    const section = root.createDiv({ cls: "collab-history-conflicts" });
    section.createEl("div", { text: `Conflict copies (${conflicts.length})`, cls: "collab-history-subtitle" });
    for (const c of conflicts) {
      const row = section.createDiv({ cls: "collab-history-row" });
      row.title = conflictTitle(c);
      const main = row.createDiv({ cls: "collab-history-main" });
      const name = c.relPath.split("/").pop() || c.relPath;
      main.createSpan({ text: name, cls: "collab-history-when" });
      const meta = [
        conflictKindLabel(c.kind),
        `for ${c.originalPath}`,
        c.createdAt ? relTime(new Date(c.createdAt).toISOString()) : "",
      ].filter(Boolean).join(" · ");
      if (meta) main.createSpan({ text: " · " + meta, cls: "collab-history-author" });
      const hashes = [shortHash(c.localHash), shortHash(c.remoteHash)].filter(Boolean);
      if (hashes.length) main.createEl("div", { text: hashes.join(" vs "), cls: "collab-history-detail" });
      const open = row.createEl("button", { cls: "collab-comment-btn" });
      setIcon(open, "file-search"); open.appendText(" Open");
      open.onclick = async (e) => {
        e.stopPropagation();
        open.disabled = true;
        const ok = await ctx.openConflict!(c.relPath);
        if (!ok) open.disabled = false;
      };
    }
  }

  private showPreview(root: HTMLElement, v: Version, content: string): void {
    const existing = root.querySelector(".collab-history-output");
    existing?.remove();
    const box = root.createDiv({ cls: "collab-history-preview collab-history-output" });
    box.createEl("div", { text: `Preview — ${relTime(v.date)}`, cls: "collab-history-when" });
    box.createEl("pre", { text: content.slice(0, 4000) + (content.length > 4000 ? "\n…" : "") });
  }

  private showDiff(root: HTMLElement, v: Version, savedContent: string, mode: "inline" | "side"): void {
    const existing = root.querySelector(".collab-history-output");
    existing?.remove();
    const current = this.ctx?.currentText() ?? "";
    const diff = buildInlineDiff(savedContent, current, { contextLines: 3 });
    const hunks = buildRestoreHunks(savedContent, current);
    const box = root.createDiv({ cls: "collab-history-preview collab-history-output" });
    const label = mode === "side" ? "Side-by-side diff" : "Diff";
    const title = `${label} — ${relTime(v.date)} to current (+${diff.added}/-${diff.removed})`;
    box.createEl("div", { text: title, cls: "collab-history-when" });

    if (diff.added === 0 && diff.removed === 0) {
      box.createEl("p", { text: "No differences from the current note.", cls: "collab-comments-empty" });
      return;
    }

    this.renderHunkActions(box, current, hunks);

    if (diff.truncated) {
      box.createEl("p", { text: "Large diff truncated for display.", cls: "collab-comments-empty" });
    }

    if (mode === "side") {
      this.renderSideBySideDiff(box, diff.rows);
    } else {
      const table = box.createDiv({ cls: "collab-history-diff" });
      for (const row of diff.rows) this.renderDiffRow(table, row);
    }
  }

  private renderHunkActions(box: HTMLElement, baselineCurrent: string, hunks: RestoreHunk[]): void {
    if (!this.ctx || hunks.length === 0) return;
    const actions = box.createDiv({ cls: "collab-history-hunks" });
    for (const hunk of hunks) {
      const btn = actions.createEl("button", { cls: "collab-comment-btn" });
      setIcon(btn, "rotate-ccw");
      btn.appendText(` Restore change ${hunk.id + 1} (+${hunk.added}/-${hunk.removed})`);
      btn.onclick = async () => {
        if (!this.ctx) return;
        if (this.ctx.currentText() !== baselineCurrent) {
          new Notice("Note changed since this diff loaded. Reopen the diff and try again.");
          return;
        }
        btn.disabled = true;
        await this.ctx.restore(applyRestoreHunk(baselineCurrent, hunk));
        new Notice("Restored that change. A pre-restore backup was saved.");
      };
    }
  }

  private renderDiffRow(table: HTMLElement, row: DiffRow): void {
    if (row.kind === "omitted") {
      const el = table.createDiv({ cls: "collab-history-diff-line omitted" });
      el.createSpan({ text: "", cls: "collab-history-diff-num" });
      el.createSpan({ text: "", cls: "collab-history-diff-num" });
      el.createSpan({ text: `... ${row.count ?? 0} unchanged line${row.count === 1 ? "" : "s"} ...`, cls: "collab-history-diff-text" });
      return;
    }

    const el = table.createDiv({ cls: `collab-history-diff-line ${row.kind}` });
    el.createSpan({ text: row.oldLine ? String(row.oldLine) : "", cls: "collab-history-diff-num" });
    el.createSpan({ text: row.newLine ? String(row.newLine) : "", cls: "collab-history-diff-num" });
    const sign = row.kind === "add" ? "+ " : row.kind === "remove" ? "- " : "  ";
    el.createSpan({ text: sign + (row.text ?? ""), cls: "collab-history-diff-text" });
  }

  private renderSideBySideDiff(box: HTMLElement, rows: DiffRow[]): void {
    const table = box.createDiv({ cls: "collab-history-side-diff" });
    const head = table.createDiv({ cls: "collab-history-side-head" });
    head.createSpan({ text: "Saved version", cls: "collab-history-side-title" });
    head.createSpan({ text: "Current note", cls: "collab-history-side-title" });

    for (const row of rows) {
      if (row.kind === "omitted") {
        const omitted = table.createDiv({ cls: "collab-history-side-omitted" });
        omitted.createSpan({ text: `... ${row.count ?? 0} unchanged line${row.count === 1 ? "" : "s"} ...` });
        continue;
      }

      const line = table.createDiv({ cls: `collab-history-side-line ${row.kind}` });
      const left = line.createDiv({ cls: "collab-history-side-cell old" });
      const right = line.createDiv({ cls: "collab-history-side-cell new" });

      if (row.kind === "remove") {
        left.createSpan({ text: row.oldLine ? String(row.oldLine) : "", cls: "collab-history-side-num" });
        left.createSpan({ text: row.text ?? "", cls: "collab-history-side-text" });
        right.createSpan({ text: "", cls: "collab-history-side-num" });
        right.createSpan({ text: "", cls: "collab-history-side-text" });
      } else if (row.kind === "add") {
        left.createSpan({ text: "", cls: "collab-history-side-num" });
        left.createSpan({ text: "", cls: "collab-history-side-text" });
        right.createSpan({ text: row.newLine ? String(row.newLine) : "", cls: "collab-history-side-num" });
        right.createSpan({ text: row.text ?? "", cls: "collab-history-side-text" });
      } else {
        left.createSpan({ text: row.oldLine ? String(row.oldLine) : "", cls: "collab-history-side-num" });
        left.createSpan({ text: row.text ?? "", cls: "collab-history-side-text" });
        right.createSpan({ text: row.newLine ? String(row.newLine) : "", cls: "collab-history-side-num" });
        right.createSpan({ text: row.text ?? "", cls: "collab-history-side-text" });
      }
    }
  }
}

function conflictKindLabel(kind: ConflictFile["kind"]): string {
  return kind === "delete" ? "Delete conflict" : "Attachment conflict";
}

function conflictTitle(c: ConflictFile): string {
  const parts = [
    conflictKindLabel(c.kind),
    `copy: ${c.relPath}`,
    `original: ${c.originalPath}`,
    c.reason ? `reason: ${c.reason}` : "",
    c.by ? `kept by: ${c.by}` : "",
  ].filter(Boolean);
  return parts.join("\n");
}

function shortHash(hash: string | undefined): string {
  return hash ? hash.slice(0, 10) : "";
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
