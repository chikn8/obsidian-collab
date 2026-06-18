import { EditorView, showPanel, Panel } from "@codemirror/view";
import { StateEffect, Extension } from "@codemirror/state";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";

/**
 * Rich presence for the active editor: a top-of-editor avatar facepile of who
 * has THIS file open, with a live-caret indicator and click-to-jump.
 *
 * Rendered as a CM6 top panel (showPanel) inside the bound editor — no fragile
 * injection into Obsidian's view DOM, and mobile-safe. A PresenceController
 * wires the manifest + file awarenesses and pushes the roster via a StateEffect.
 */
export interface RosterEntry {
  presenceKey: string;
  uid: string;
  name: string;
  color: string;
  device?: string;
  typing: boolean;
  hasCaret: boolean; // a resolvable cursor on this file (focused), vs file-open-only
  isSelf?: boolean;  // you — shown as a "connected" confidence marker
}

const setRoster = StateEffect.define<RosterEntry[]>();

export function facepileExtension(onJump: (uid: string) => void): Extension {
  return showPanel.of((view) => makePanel(view, onJump));
}

function makePanel(_view: EditorView, onJump: (uid: string) => void): Panel {
  const dom = document.createElement("div");
  dom.className = "collab-facepile";

  const render = (roster: RosterEntry[]) => {
    dom.replaceChildren();
    if (roster.length === 0) { dom.addClass("empty"); return; }
    dom.removeClass("empty");
    for (const u of roster) {
      const av = document.createElement("button");
      av.className = "collab-facepile-avatar"
        + (u.hasCaret ? " live" : "") + (u.typing ? " typing" : "") + (u.isSelf ? " self" : "");
      av.style.backgroundColor = u.color;
      av.textContent = (u.name?.trim()?.[0] || "?").toUpperCase();
      const status = u.typing ? "typing…" : u.hasCaret ? "editing" : "viewing";
      av.title = u.isSelf
        ? `${u.name} (you) — connected`
        : `${u.name}${u.device ? ` (${u.device})` : ""} — ${status}` + (u.hasCaret ? " · click to jump" : "");
      av.setAttribute("aria-label", av.title);
      if (u.hasCaret && !u.isSelf) av.onclick = () => onJump(u.presenceKey);
      else av.disabled = true;
      dom.appendChild(av);
    }
  };
  render([]);

  return {
    top: true,
    dom,
    update(u) {
      for (const tr of u.transactions) {
        for (const e of tr.effects) if (e.is(setRoster)) render(e.value);
      }
    },
  };
}

/** Wires awareness → facepile + jump, for one bound editor. Torn down on unbind. */
export class PresenceController {
  private cleanup: (() => void)[] = [];

  constructor(
    private view: EditorView,
    private doc: Y.Doc,
    private manifestAwareness: Awareness,
    private fileAwareness: Awareness,
    private relPath: string
  ) {}

  private typingTimer: ReturnType<typeof setTimeout> | null = null;

  extension(): Extension {
    return [
      facepileExtension((uid) => this.jumpTo(uid)),
      EditorView.updateListener.of((u) => { if (u.docChanged) this.bumpTyping(); }),
    ];
  }

  private bumpTyping(): void {
    this.setTyping(true);
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => this.setTyping(false), 1500);
  }

  start(): void {
    const onChange = () => this.refresh();
    this.manifestAwareness.on("change", onChange);
    this.fileAwareness.on("change", onChange);
    this.cleanup.push(() => this.manifestAwareness.off("change", onChange));
    this.cleanup.push(() => this.fileAwareness.off("change", onChange));
    this.refresh();
  }

  stop(): void {
    if (this.typingTimer) { clearTimeout(this.typingTimer); this.typingTimer = null; }
    this.setTyping(false);
    for (const c of this.cleanup) c();
    this.cleanup = [];
  }

  /** Broadcast our own typing state on the manifest awareness. */
  setTyping(typing: boolean): void {
    const cur = this.manifestAwareness.getLocalState()?.presence || {};
    this.manifestAwareness.setLocalStateField("presence", { ...cur, typing, activeFile: this.relPath });
  }

  private refresh(): void {
    // Who has this file open (manifest awareness presence.activeFile === relPath)
    const caretKeys = new Set<string>();
    this.fileAwareness.getStates().forEach((s: any, clientId: number) => {
      if (s?.user?.uid && s?.cursor) caretKeys.add(presenceKey(s, clientId));
    });

    const roster: RosterEntry[] = [];
    const seen = new Set<string>();
    const myClientId = (this.manifestAwareness as any).clientID;
    this.manifestAwareness.getStates().forEach((s: any, clientId: number) => {
      const u = s?.user;
      const p = s?.presence;
      if (!u?.uid) return;
      // Include yourself too (a "you're connected" marker), as long as this is
      // the file you have open.
      if (!p || p.activeFile !== this.relPath) return;
      const key = presenceKey(s, clientId);
      if (seen.has(key)) return;
      seen.add(key);
      roster.push({
        presenceKey: key,
        uid: u.uid,
        name: u.name || "Anonymous",
        color: u.color || "#888",
        device: u.device,
        typing: !!p.typing,
        hasCaret: caretKeys.has(key),
        isSelf: clientId === myClientId,
      });
    });
    // You first, then everyone else alphabetically.
    roster.sort((a, b) => (a.isSelf === b.isSelf ? a.name.localeCompare(b.name) : a.isSelf ? -1 : 1));
    this.view.dispatch({ effects: setRoster.of(roster) });
  }

  /** Jump to a collaborator's caret on this file (focused peers only). */
  private jumpTo(targetKey: string): void {
    let target: any = null;
    this.fileAwareness.getStates().forEach((s: any, clientId: number) => {
      if (presenceKey(s, clientId) === targetKey && s?.cursor) target = s.cursor;
    });
    if (!target) return; // background/unfocused peer — no live caret to jump to
    const idx = resolveAwarenessCursor(target.head ?? target.anchor, this.doc);
    if (idx == null) return;
    const pos = Math.min(idx, this.view.state.doc.length);
    this.view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "center" }) });
  }
}

function presenceKey(state: any, clientId: number): string {
  const uid = state?.user?.uid || "unknown";
  return `${uid}:${state?.user?.deviceId || clientId}`;
}

/** Resolve a yCollab awareness cursor (a relative position) to an absolute index. */
function resolveAwarenessCursor(rel: any, doc: Y.Doc): number | null {
  if (rel == null) return null;
  try {
    const rp = typeof rel === "object" && rel.type !== undefined ? rel : Y.createRelativePositionFromJSON(rel);
    const abs = Y.createAbsolutePositionFromRelativePosition(rp, doc);
    return abs ? abs.index : null;
  } catch {
    try {
      const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(rel), doc);
      return abs ? abs.index : null;
    } catch {
      return null;
    }
  }
}
