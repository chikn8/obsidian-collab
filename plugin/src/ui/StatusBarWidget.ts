import type { SyncStatus } from "../types";

export interface ShareStatus {
  label: string;
  status: SyncStatus;
  fileCount: number;
  /** Local edits made while offline that will sync on reconnect. */
  pending?: number;
}

/**
 * Aggregate status bar across all active shares.
 *  - dot color reflects the overall connection state
 *  - text summarises files + folders synced
 *  - tooltip breaks it down per share
 */
export class StatusBarWidget {
  private el: HTMLElement;
  private shares: Map<string, ShareStatus> = new Map();

  constructor(statusBarEl: HTMLElement) {
    this.el = statusBarEl;
    this.el.addClass("collab-status-bar");
    this.render();
  }

  setShare(shareId: string, status: ShareStatus): void {
    this.shares.set(shareId, status);
    this.render();
  }

  removeShare(shareId: string): void {
    this.shares.delete(shareId);
    this.render();
  }

  clear(): void {
    this.shares.clear();
    this.render();
  }

  /** Worst-of overall status: error > connecting/syncing > connected > off. */
  private overall(): SyncStatus {
    const all = Array.from(this.shares.values()).map((s) => s.status);
    if (all.length === 0) return "disconnected";
    if (all.includes("error")) return "error";
    if (all.includes("connecting")) return "connecting";
    if (all.includes("syncing")) return "syncing";
    if (all.includes("connected")) return "connected";
    return "disconnected";
  }

  private render(): void {
    this.el.empty();

    const status = this.overall();
    const dot = this.el.createEl("span", { cls: "collab-status-dot" });
    dot.addClass(status);

    const folders = this.shares.size;
    const files = Array.from(this.shares.values()).reduce((n, s) => n + s.fileCount, 0);
    const pending = Array.from(this.shares.values()).reduce((n, s) => n + (s.pending || 0), 0);

    let text = "";
    switch (status) {
      case "disconnected": text = "Sync: Off"; break;
      case "connecting":   text = "Sync: Connecting…"; break;
      case "syncing":      text = "Sync: Syncing…"; break;
      case "error":        text = "Sync: Error"; break;
      case "connected":
        text = `Sync: ${files} file${files !== 1 ? "s" : ""} · ${folders} folder${folders !== 1 ? "s" : ""}`;
        break;
    }
    this.el.createEl("span", { text });

    // Offline-pending indicator: edits made while disconnected, queued for sync.
    if (pending > 0 && status !== "connected") {
      const warn = this.el.createEl("span", {
        text: ` · ⏳ ${pending} change${pending !== 1 ? "s" : ""} pending`,
        cls: "collab-status-pending",
      });
      warn.setAttribute("aria-label", `${pending} local change${pending !== 1 ? "s" : ""} will sync when you reconnect`);
    }

    if (this.shares.size > 0) {
      const lines = Array.from(this.shares.values())
        .map((s) => `${s.label}: ${s.status}${s.status === "connected" ? ` (${s.fileCount})` : ""}${s.pending ? ` · ${s.pending} pending` : ""}`)
        .join("\n");
      this.el.setAttribute("aria-label", lines);
    }
  }
}
