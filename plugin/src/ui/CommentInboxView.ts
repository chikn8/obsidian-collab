import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";

export const COMMENT_INBOX_VIEW_TYPE = "collab-comment-inbox";

export interface CommentInboxItem {
  key: string;
  filePath: string;
  fileName: string;
  threadId: string;
  authorName: string;
  quote: string;
  text: string;
  lastAt: number;
}

export interface CommentInboxContext {
  items: () => CommentInboxItem[];
  open: (item: CommentInboxItem) => Promise<void>;
  markAllRead: () => void;
  now: () => number;
}

export class CommentInboxView extends ItemView {
  private ctx: CommentInboxContext | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string { return COMMENT_INBOX_VIEW_TYPE; }
  getDisplayText(): string { return "Comment inbox"; }
  getIcon(): string { return "inbox"; }

  async onOpen(): Promise<void> { this.render(); }

  setContext(ctx: CommentInboxContext | null): void {
    this.ctx = ctx;
    this.render();
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("collab-history-view");

    const header = root.createDiv({ cls: "collab-comments-header" });
    header.createEl("div", { text: "Unread comments", cls: "collab-history-title" });
    if (this.ctx) {
      const mark = header.createEl("button", { cls: "collab-comment-btn" });
      setIcon(mark, "check-check");
      mark.appendText(" Mark all read");
      mark.onclick = () => { this.ctx?.markAllRead(); this.render(); };
    }

    if (!this.ctx) {
      root.createEl("p", { text: "Open a synced vault to collect comment activity.", cls: "collab-comments-empty" });
      return;
    }

    const items = this.ctx.items();
    if (items.length === 0) {
      root.createEl("p", { text: "No unread comments.", cls: "collab-comments-empty" });
      return;
    }

    const list = root.createDiv({ cls: "collab-history-list" });
    for (const item of items) {
      const row = list.createDiv({ cls: "collab-history-row" });
      const main = row.createDiv({ cls: "collab-history-main" });
      main.createSpan({ text: item.fileName, cls: "collab-history-when" });
      main.createSpan({ text: ` · ${item.authorName || "unknown"} · ${timeAgo(this.ctx.now(), item.lastAt)}`, cls: "collab-history-author" });
      row.createDiv({ text: item.text || item.quote, cls: "collab-comment-text" });
      row.onclick = () => void this.ctx?.open(item);
    }
  }
}

function timeAgo(now: number, then: number): string {
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
