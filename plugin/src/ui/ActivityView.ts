import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import { formatEvent, type CollabEvent } from "../collab/EventLog";

export const ACTIVITY_VIEW_TYPE = "collab-activity";

export interface ActivityContext {
  shareLabel: string;
  events: () => CollabEvent[];
  observe: (cb: () => void) => () => void;
  send: (text: string) => void;
  now: () => number;
  canSend: boolean;
}

export class ActivityView extends ItemView {
  private ctx: ActivityContext | null = null;
  private unobserve: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string { return ACTIVITY_VIEW_TYPE; }
  getDisplayText(): string { return "Collab activity"; }
  getIcon(): string { return "message-circle"; }

  async onOpen(): Promise<void> { this.render(); }
  async onClose(): Promise<void> { this.unobserve?.(); this.unobserve = null; }

  setContext(ctx: ActivityContext | null): void {
    this.unobserve?.();
    this.unobserve = null;
    this.ctx = ctx;
    if (ctx) this.unobserve = ctx.observe(() => this.render());
    this.render();
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("collab-activity-view");

    const header = root.createDiv({ cls: "collab-activity-header" });
    header.createEl("div", { text: this.ctx ? this.ctx.shareLabel : "Activity", cls: "collab-activity-title" });
    if (this.ctx) {
      const count = this.ctx.events().length;
      header.createEl("div", { text: `${count}`, cls: "collab-activity-count" });
    }

    if (!this.ctx) {
      root.createEl("p", { text: "Open or join a synced folder to see activity.", cls: "collab-comments-empty" });
      return;
    }

    const list = root.createDiv({ cls: "collab-activity-list" });
    const events = this.ctx.events();
    if (events.length === 0) {
      list.createEl("p", { text: "No activity yet.", cls: "collab-comments-empty" });
    } else {
      for (const event of events) this.renderEvent(list, event);
    }

    const composer = root.createDiv({ cls: "collab-activity-composer" });
    const input = composer.createEl("input", {
      type: "text",
      placeholder: "Message",
      cls: "collab-activity-input",
    });
    const sendBtn = composer.createEl("button", { cls: "collab-comment-btn collab-activity-send" });
    setIcon(sendBtn, "send");
    sendBtn.setAttr("aria-label", "Send message");
    const send = () => {
      if (!this.ctx) return;
      const text = input.value.trim();
      if (!text) return;
      if (!this.ctx.canSend) {
        new Notice("This share is read-only on this device.");
        return;
      }
      this.ctx.send(text);
      input.value = "";
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        send();
      }
    });
    sendBtn.onclick = send;
  }

  private renderEvent(parent: HTMLElement, event: CollabEvent): void {
    const isMessage = event.type === "message";
    const row = parent.createDiv({ cls: `collab-activity-row ${isMessage ? "message" : "event"}` });
    const meta = row.createDiv({ cls: "collab-activity-meta" });
    meta.createSpan({ text: event.actorName || "Anonymous", cls: "collab-activity-author" });
    meta.createSpan({ text: " · " + timeAgo(this.ctx?.now() || Date.now(), event.at), cls: "collab-activity-time" });
    if (event.device) meta.createSpan({ text: " · " + event.device, cls: "collab-activity-device" });

    const body = row.createDiv({ cls: "collab-activity-body" });
    if (isMessage) {
      body.setText(event.text || "");
      return;
    }
    body.setText(formatEvent(event));
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
