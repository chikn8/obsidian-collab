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

const GROUP_WINDOW_MS = 10 * 60 * 1000;

interface ActivityGroup {
  actorKey: string;
  events: CollabEvent[];
}

export class ActivityView extends ItemView {
  private ctx: ActivityContext | null = null;
  private unobserve: (() => void) | null = null;
  private draft = "";

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
      for (const group of groupEvents(events)) this.renderGroup(list, group);
    }

    const composer = root.createDiv({ cls: "collab-activity-composer" });
    const input = composer.createEl("input", {
      type: "text",
      placeholder: "Message",
      cls: "collab-activity-input",
    });
    input.value = this.draft;
    input.addEventListener("input", () => {
      this.draft = input.value;
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
      input.value = "";
      this.draft = "";
      this.ctx.send(text);
      this.scrollToBottom(list);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        send();
      }
    });
    sendBtn.onclick = send;
    this.scrollToBottom(list);
  }

  private renderGroup(parent: HTMLElement, group: ActivityGroup): void {
    const first = group.events[0];
    const latest = group.events[group.events.length - 1] || first;
    if (!first || !latest) return;

    const row = parent.createDiv({ cls: "collab-activity-row" });
    const avatar = row.createDiv({ cls: "collab-activity-avatar" });
    avatar.setText(actorInitial(first.actorName));
    avatar.setAttr("aria-label", first.actorName || "Anonymous");
    avatar.setAttr("title", first.actorName || "Anonymous");
    avatar.style.backgroundColor = actorColor(first);

    const content = row.createDiv({ cls: "collab-activity-content" });
    const meta = content.createDiv({ cls: "collab-activity-meta" });
    meta.createSpan({ text: first.actorName || "Anonymous", cls: "collab-activity-author" });
    meta.createSpan({ text: " · " + timeAgo(this.ctx?.now() || Date.now(), latest.at), cls: "collab-activity-time" });
    const device = sameDevice(group.events);
    if (device) meta.createSpan({ text: " · " + device, cls: "collab-activity-device" });

    const items = content.createDiv({ cls: "collab-activity-items" });
    for (const event of group.events) this.renderGroupItem(items, event);
  }

  private renderGroupItem(parent: HTMLElement, event: CollabEvent): void {
    const isMessage = event.type === "message";
    const item = parent.createDiv({ cls: `collab-activity-item ${isMessage ? "message" : "event"} type-${event.type}` });
    if (!isMessage) {
      const action = item.createSpan({ cls: `collab-activity-action type-${event.type}` });
      setIcon(action, actionIcon(event.type));
      action.setAttr("aria-label", actionLabel(event.type));
      action.setAttr("title", actionLabel(event.type));
    }

    const body = item.createSpan({ cls: "collab-activity-body" });
    if (isMessage) {
      body.setText(event.text || "");
      return;
    }
    body.setText(withoutActorPrefix(formatEvent(event), event.actorName));
  }

  private scrollToBottom(list: HTMLElement): void {
    const scroll = () => { list.scrollTop = list.scrollHeight; };
    scroll();
    requestAnimationFrame(scroll);
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

function groupEvents(events: CollabEvent[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  for (const event of events) {
    const key = actorKey(event);
    const last = groups[groups.length - 1];
    const previous = last?.events[last.events.length - 1];
    if (
      last &&
      previous &&
      last.actorKey === key &&
      Math.max(0, event.at - previous.at) <= GROUP_WINDOW_MS
    ) {
      last.events.push(event);
      continue;
    }
    groups.push({ actorKey: key, events: [event] });
  }
  return groups;
}

function actorKey(event: CollabEvent): string {
  return event.actorUid || event.actorName || "anonymous";
}

function sameDevice(events: CollabEvent[]): string {
  const first = events[0]?.device || "";
  if (!first) return "";
  return events.every((event) => (event.device || "") === first) ? first : "";
}

function actorInitial(name: string): string {
  const clean = (name || "Anonymous").trim();
  return (clean[0] || "?").toUpperCase();
}

function actorColor(event: CollabEvent): string {
  const key = event.actorUid || event.actorName || "anonymous";
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360}, 62%, 46%)`;
}

function actionIcon(type: CollabEvent["type"]): string {
  switch (type) {
    case "message": return "message-circle";
    case "online": return "log-in";
    case "offline": return "log-out";
    case "open": return "file-text";
    case "edit": return "pencil";
    case "create": return "file-plus";
    case "delete": return "trash-2";
    case "rename": return "file-pen-line";
    case "restore": return "archive-restore";
    case "resurrect": return "rotate-ccw";
    case "conflict": return "triangle-alert";
    case "binary": return "paperclip";
    case "system": return "info";
    default: return "circle";
  }
}

function actionLabel(type: CollabEvent["type"]): string {
  switch (type) {
    case "message": return "Message";
    case "online": return "Online";
    case "offline": return "Offline";
    case "open": return "Opened file";
    case "edit": return "Edited file";
    case "create": return "Created file";
    case "delete": return "Deleted file";
    case "rename": return "Renamed file";
    case "restore": return "Restored file";
    case "resurrect": return "Recovered local edit";
    case "conflict": return "Conflict copy";
    case "binary": return "Attachment update";
    case "system": return "System";
    default: return "Activity";
  }
}

function withoutActorPrefix(text: string, actorName: string): string {
  const cleanActor = (actorName || "").trim();
  if (!cleanActor || !text.startsWith(cleanActor)) return text;
  const next = text.slice(cleanActor.length);
  return next.trimStart();
}
