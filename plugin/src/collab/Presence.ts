import { EditorView, showPanel, Panel } from "@codemirror/view";
import { StateEffect, Extension } from "@codemirror/state";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import {
  collectPresenceDevices,
  presenceInitial,
  presenceKeyFromState,
  presenceLabel,
  type PresenceDevice,
} from "./PresenceModel";
import { makeTypingDots } from "./PresenceDom";

/**
 * Rich presence for the active editor: a top-of-editor avatar facepile of who
 * has THIS file open, with a live-caret indicator and click-to-jump.
 *
 * Rendered as a CM6 top panel (showPanel) inside the bound editor — no fragile
 * injection into Obsidian's view DOM, and mobile-safe. A PresenceController
 * wires the manifest + file awarenesses and pushes the roster via a StateEffect.
 */
export type RosterEntry = PresenceDevice;

const setRoster = StateEffect.define<RosterEntry[]>();

export function facepileExtension(onJump: (uid: string) => void): Extension {
  return showPanel.of((view) => makePanel(view, onJump));
}

function makePanel(_view: EditorView, onJump: (uid: string) => void): Panel {
  const dom = document.createElement("div");
  dom.className = "collab-facepile";

  const render = (roster: RosterEntry[]) => {
    renderFacepileRoster(dom, roster, onJump);
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

export function renderFacepileRoster(
  dom: HTMLElement,
  roster: RosterEntry[],
  onJump: (uid: string) => void
): void {
  const doc = dom.ownerDocument || document;
  dom.replaceChildren();
  if (roster.length === 0) {
    dom.classList.add("empty");
    return;
  }
  dom.classList.remove("empty");
  for (const u of roster) {
    const canJump = u.hasCaret && !u.isSelf;
    const av = doc.createElement(canJump ? "button" : "span");
    av.className = "collab-facepile-avatar"
      + (u.hasCaret ? " live" : "") + (u.typing ? " typing" : "") + (u.isSelf ? " self" : "");
    av.style.backgroundColor = u.color;
    av.textContent = presenceInitial(u.name);
    av.title = presenceLabel(u) + (canJump ? " - click to jump" : "");
    av.setAttribute("aria-label", av.title);
    if (u.typing) av.appendChild(makeTypingDots(doc));
    if (canJump) {
      (av as HTMLButtonElement).type = "button";
      av.onclick = () => onJump(u.presenceKey);
    } else {
      av.setAttribute("role", "img");
    }
    dom.appendChild(av);
  }
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

  extension(showFacepile = true): Extension {
    return [
      ...(showFacepile ? [facepileExtension((uid) => this.jumpTo(uid))] : []),
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
    this.setTyping(false);
    this.refresh();
  }

  stop(): void {
    if (this.typingTimer) { clearTimeout(this.typingTimer); this.typingTimer = null; }
    for (const c of this.cleanup) c();
    this.cleanup = [];
    const cur = this.manifestAwareness.getLocalState()?.presence || {};
    this.manifestAwareness.setLocalStateField("presence", { ...cur, typing: false, activeFile: null });
  }

  /** Broadcast our own typing state on the manifest awareness. */
  setTyping(typing: boolean): void {
    const cur = this.manifestAwareness.getLocalState()?.presence || {};
    this.manifestAwareness.setLocalStateField("presence", { ...cur, typing, activeFile: this.relPath });
  }

  private refresh(): void {
    this.ensureLocalPresence();
    // Who has this file open (manifest awareness presence.activeFile === relPath)
    const caretKeys = new Set<string>();
    this.fileAwareness.getStates().forEach((s: any, clientId: number) => {
      if (s?.user?.uid && s?.cursor) caretKeys.add(presenceKeyFromState(s, clientId));
    });

    const roster = collectPresenceDevices({
      manifestAwareness: this.manifestAwareness,
      relPath: this.relPath,
      caretKeys,
    });
    this.view.dispatch({ effects: setRoster.of(roster) });
  }

  private ensureLocalPresence(): void {
    const cur = this.manifestAwareness.getLocalState()?.presence || {};
    if (cur.activeFile === this.relPath) return;
    this.manifestAwareness.setLocalStateField("presence", { ...cur, activeFile: this.relPath });
  }

  /** Jump to a collaborator's caret on this file (focused peers only). */
  private jumpTo(targetKey: string): void {
    let target: any = null;
    this.fileAwareness.getStates().forEach((s: any, clientId: number) => {
      if (presenceKeyFromState(s, clientId) === targetKey && s?.cursor) target = s.cursor;
    });
    if (!target) return; // background/unfocused peer — no live caret to jump to
    const idx = resolveAwarenessCursor(target.head ?? target.anchor, this.doc);
    if (idx == null) return;
    const pos = Math.min(idx, this.view.state.doc.length);
    this.view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "center" }) });
  }
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
