import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type { CommentStore, ThreadView } from "../collab/CommentStore";
import type { CommentSession } from "../collab/CommentLayer";
import type { MentionUser } from "../utils/mentions";
import type { CommentEventKind } from "../utils/commentNotifications";
import { wireMentionAutocomplete } from "./mentionInput";

export const COMMENTS_VIEW_TYPE = "collab-comments";

export interface CommentContext {
  store: CommentStore;
  session: CommentSession | null;
  fileName: string;
  me: { uid: string; name: string };
  now: () => number;
  mentionUsers: () => MentionUser[];
  /** Scan text for @mentions of collaborators and push them a notification. */
  notifyFromText: (text: string) => Set<string>;
  notifyThreadEvent: (thread: ThreadView, kind: CommentEventKind, text: string, alreadyNotified: Set<string>) => void;
}

const REACTIONS = ["👍", "❤️", "🎉", "😄", "👀"];

export class CommentsView extends ItemView {
  private ctx: CommentContext | null = null;
  private unobserve: (() => void) | null = null;
  private showResolved = false;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string { return COMMENTS_VIEW_TYPE; }
  getDisplayText(): string { return "Comments"; }
  getIcon(): string { return "message-square"; }

  async onOpen(): Promise<void> { this.render(); }
  async onClose(): Promise<void> { this.unobserve?.(); this.unobserve = null; }

  /** Plugin calls this on active-file change / bind. */
  setContext(ctx: CommentContext | null): void {
    this.unobserve?.();
    this.unobserve = null;
    this.ctx = ctx;
    if (ctx) this.unobserve = ctx.store.observe(() => this.render());
    this.render();
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("collab-comments-view");

    const header = root.createDiv({ cls: "collab-comments-header" });
    header.createEl("div", { text: this.ctx ? `Comments — ${this.ctx.fileName}` : "Comments", cls: "collab-comments-title" });
    if (this.ctx) {
      const toggle = header.createEl("label", { cls: "collab-comments-toggle" });
      const cb = toggle.createEl("input", { type: "checkbox" });
      cb.checked = this.showResolved;
      toggle.appendText(" resolved");
      cb.onchange = () => { this.showResolved = cb.checked; this.render(); };
    }

    if (!this.ctx) {
      root.createEl("p", { text: "Open a synced note to see and add comments.", cls: "collab-comments-empty" });
      return;
    }

    const threads = this.ctx.store.list();
    const visible = threads.filter((t) => this.showResolved || !t.resolved);
    if (visible.length === 0) {
      root.createEl("p", { text: "No comments yet. Select text, then run Add comment to selection.", cls: "collab-comments-empty" });
      return;
    }

    const list = root.createDiv({ cls: "collab-comments-list" });
    for (const t of visible) this.renderThread(list, t);
  }

  private renderThread(parent: HTMLElement, t: ThreadView): void {
    const card = parent.createDiv({ cls: "collab-comment-card" + (t.resolved ? " resolved" : "") });

    // quote / anchor row (click to jump)
    const quote = card.createDiv({ cls: "collab-comment-quote" });
    if (t.anchor?.lost) quote.addClass("lost");
    quote.setText(t.anchor?.lost ? `“${t.quote}” (context lost)` : `“${t.quote}”`);
    quote.onclick = () => { if (!t.anchor?.lost) this.ctx?.session?.reveal(t.id); };

    // replies (first reply is the opening comment)
    for (const r of t.replies) {
      const row = card.createDiv({ cls: "collab-comment-reply" });
      const meta = row.createDiv({ cls: "collab-comment-meta" });
      meta.createSpan({ text: r.byName, cls: "collab-comment-author" });
      meta.createSpan({ text: " · " + timeAgo(this.ctx!.now(), r.at), cls: "collab-comment-time" });
      row.createDiv({ cls: "collab-comment-text", text: r.text });

      const react = row.createDiv({ cls: "collab-comment-reactions" });
      for (const [emoji, n] of Object.entries(r.reactions)) {
        const chip = react.createEl("button", { cls: "collab-reaction", text: `${emoji} ${n}` });
        chip.onclick = () => this.ctx!.store.react(t.id, r.id, emoji, +1);
      }
      const addReact = react.createEl("button", { cls: "collab-reaction add", text: "＋" });
      addReact.onclick = (e) => this.reactionMenu(e, t.id, r.id);
    }

    // actions
    const actions = card.createDiv({ cls: "collab-comment-actions" });
    const replyInput = actions.createEl("input", { type: "text", placeholder: "Reply… (@name to notify)", cls: "collab-comment-input" });
    wireMentionAutocomplete(actions, replyInput, () => this.ctx?.mentionUsers() ?? []);
    const send = () => {
      const text = replyInput.value.trim();
      if (!text) return;
      this.ctx!.store.addReply(t.id, { byUid: this.ctx!.me.uid, byName: this.ctx!.me.name, text, at: this.ctx!.now() });
      const notified = this.ctx!.notifyFromText(text);
      this.ctx!.notifyThreadEvent(t, "reply", text, notified);
      replyInput.value = "";
    };
    replyInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); send(); } });

    const resolveBtn = actions.createEl("button", { cls: "collab-comment-btn" });
    setIcon(resolveBtn, t.resolved ? "rotate-ccw" : "check");
    resolveBtn.setAttr("aria-label", t.resolved ? "Reopen" : "Resolve");
    resolveBtn.onclick = () => {
      const next = !t.resolved;
      this.ctx!.store.setResolved(t.id, next);
      this.ctx!.notifyThreadEvent(t, next ? "resolve" : "reopen", "", new Set());
    };

    if (t.authorUid === this.ctx!.me.uid) {
      const del = actions.createEl("button", { cls: "collab-comment-btn" });
      setIcon(del, "trash-2");
      del.setAttr("aria-label", "Delete thread");
      del.onclick = () => this.ctx!.store.deleteThread(t.id);
    }
  }

  private reactionMenu(e: MouseEvent, threadId: string, replyId: string): void {
    const host = (e.target as HTMLElement).parentElement!;
    const existing = host.querySelector(".collab-reaction-picker");
    if (existing) { existing.remove(); return; }
    const picker = host.createDiv({ cls: "collab-reaction-picker" });
    for (const emoji of REACTIONS) {
      const b = picker.createEl("button", { text: emoji });
      b.onclick = () => { this.ctx!.store.react(threadId, replyId, emoji, +1); picker.remove(); };
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
