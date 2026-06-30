import { StateEffect, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { trace } from "../utils/log";

const refreshRemoteCursors = StateEffect.define<void>();
const MAX_REMOTE_SELECTION_CHARS = 2000;

export function cursorAwarenessExtension(
  ytext: Y.Text,
  awareness: Awareness,
  options: { label?: string } = {}
): Extension {
  return [
    ViewPlugin.define((view) => new CursorAwarenessPlugin(view, ytext, awareness, options.label), {
      decorations: (plugin) => plugin.decorations,
    }),
  ];
}

class CursorAwarenessPlugin {
  decorations: DecorationSet = Decoration.none;
  private awarenessListener: (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => void;
  private lastRenderSig = "";
  private refreshQueued = false;
  private destroyed = false;

  constructor(
    private view: EditorView,
    private ytext: Y.Text,
    private awareness: Awareness,
    private label?: string
  ) {
    this.awarenessListener = ({ added, updated, removed }, origin) => {
      const changedRemote = added.concat(updated, removed).filter((id) => id !== this.awareness.clientID);
      if (changedRemote.length === 0) return;
      trace("awareness", "cursor-remote-change", {
        label: this.label,
        added: added.length,
        updated: updated.length,
        removed: removed.length,
        remoteChanged: changedRemote.length,
        origin: originName(origin),
      });
      this.requestRemoteRefresh();
    };
    this.awareness.on("change", this.awarenessListener);
    this.publishLocalCursor(view, "init");
    this.rebuild(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet || update.focusChanged) {
      this.publishLocalCursor(update.view, updateReason(update));
    }
    if (
      update.docChanged ||
      update.viewportChanged ||
      update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refreshRemoteCursors)))
    ) {
      this.rebuild(update.view);
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.awareness.off("change", this.awarenessListener);
    this.clearLocalCursor("destroy");
  }

  private requestRemoteRefresh(): void {
    if (this.refreshQueued || this.destroyed) return;
    this.refreshQueued = true;
    queueMicrotask(() => {
      this.refreshQueued = false;
      if (this.destroyed) return;
      this.view.dispatch({ effects: refreshRemoteCursors.of(undefined) });
    });
  }

  private publishLocalCursor(view: EditorView, reason: string): void {
    const local = this.awareness.getLocalState?.();
    if (!local) return;

    if (reason === "focus" && !view.hasFocus) {
      trace("awareness", "cursor-focus-lost-retained", {
        label: this.label,
        clientId: this.awareness.clientID,
      });
      return;
    }

    const sel = view.state.selection.main;
    const anchor = Y.createRelativePositionFromTypeIndex(this.ytext, sel.anchor);
    const head = Y.createRelativePositionFromTypeIndex(this.ytext, sel.head);
    if (sameStoredCursor(local.cursor, anchor, head)) return;

    this.awareness.setLocalStateField("cursor", { anchor, head });
    trace("awareness", "cursor-local", {
      label: this.label,
      reason,
      clientId: this.awareness.clientID,
      anchor: sel.anchor,
      head: sel.head,
      empty: sel.empty,
    });
  }

  private clearLocalCursor(reason: string): void {
    const local = this.awareness.getLocalState?.();
    if (!local?.cursor) return;
    this.awareness.setLocalStateField("cursor", null);
    trace("awareness", "cursor-local-cleared", {
      label: this.label,
      reason,
      clientId: this.awareness.clientID,
    });
  }

  private rebuild(view: EditorView): void {
    const ranges: Range<Decoration>[] = [];
    const docLen = view.state.doc.length;
    const localUser = this.awareness.getLocalState?.()?.user;
    let rendered = 0;
    let invalid = 0;
    let skippedSelf = 0;

    this.awareness.getStates().forEach((state: any, clientId: number) => {
      if (clientId === this.awareness.clientID) {
        skippedSelf++;
        return;
      }
      if (sameIdentity(localUser, state?.user)) {
        skippedSelf++;
        return;
      }
      const cursor = state?.cursor;
      if (!cursor?.anchor || !cursor?.head) return;
      const anchor = absoluteIndex(cursor.anchor, this.ytext);
      const head = absoluteIndex(cursor.head, this.ytext);
      if (anchor == null || head == null) {
        invalid++;
        return;
      }

      const start = clamp(Math.min(anchor, head), 0, docLen);
      const end = clamp(Math.max(anchor, head), 0, docLen);
      const color = validColor(state?.user?.color) || "#30bced";
      const colorLight = validColorLight(state?.user?.colorLight) || `${color}33`;
      const name = state?.user?.name || state?.user?.displayName || "Anonymous";
      const key = `${state?.user?.uid || clientId}:${state?.user?.deviceId || clientId}`;

      if (start < end && end - start <= MAX_REMOTE_SELECTION_CHARS) {
        ranges.push(Decoration.mark({
          class: "cm-ySelection",
          attributes: { style: `background-color: ${colorLight}` },
        }).range(start, end));
      }
      ranges.push(Decoration.widget({
        side: head >= anchor ? 1 : -1,
        widget: new RemoteCaretWidget(color, name, key),
      }).range(clamp(head, 0, docLen)));
      rendered++;
    });

    this.decorations = Decoration.set(ranges, true);
    const sig = `${rendered}:${invalid}:${skippedSelf}:${ranges.length}`;
    if (sig !== this.lastRenderSig) {
      this.lastRenderSig = sig;
      trace("awareness", "cursor-render", {
        label: this.label,
        rendered,
        invalid,
        skippedSelf,
        states: this.awareness.getStates().size,
      });
    }
  }
}

class RemoteCaretWidget extends WidgetType {
  constructor(
    private color: string,
    private name: string,
    private key: string
  ) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    return renderRemoteCaret(view.dom.ownerDocument || document, this.color, this.name, this.key);
  }

  eq(other: RemoteCaretWidget): boolean {
    return this.color === other.color && this.name === other.name && this.key === other.key;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export function renderRemoteCaret(doc: Document, color: string, name: string, key: string): HTMLElement {
  const el = doc.createElement("span");
  el.className = "cm-ySelectionCaret";
  el.style.setProperty("--collab-cursor-color", color);
  el.dataset.collabCursorKey = key;

  const line = doc.createElement("span");
  line.className = "cm-ySelectionCaretLine";
  el.appendChild(line);

  const dot = doc.createElement("span");
  dot.className = "cm-ySelectionCaretDot";
  el.appendChild(dot);

  const info = doc.createElement("span");
  info.className = "cm-ySelectionInfo";
  info.textContent = name;
  el.appendChild(info);

  return el;
}

function sameStoredCursor(cursor: any, anchor: Y.RelativePosition, head: Y.RelativePosition): boolean {
  if (!cursor?.anchor || !cursor?.head) return false;
  const currentAnchor = storedRelativePosition(cursor.anchor);
  const currentHead = storedRelativePosition(cursor.head);
  return !!currentAnchor &&
    !!currentHead &&
    Y.compareRelativePositions(currentAnchor, anchor) &&
    Y.compareRelativePositions(currentHead, head);
}

function storedRelativePosition(value: any): Y.RelativePosition | null {
  if (!value) return null;
  try {
    return typeof value === "object" && value.type !== undefined
      ? value as Y.RelativePosition
      : Y.createRelativePositionFromJSON(value);
  } catch {
    return null;
  }
}

function absoluteIndex(value: any, ytext: Y.Text): number | null {
  const pos = storedRelativePosition(value);
  if (!pos) return null;
  try {
    const abs = Y.createAbsolutePositionFromRelativePosition(pos, ytext.doc!);
    if (!abs || abs.type !== ytext) return null;
    return abs.index;
  } catch {
    return null;
  }
}

function sameIdentity(a: any, b: any): boolean {
  return !!a?.uid && !!b?.uid && a.uid === b.uid && (a.deviceId || "") === (b.deviceId || "");
}

function validColor(value: unknown): string | null {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : null;
}

function validColorLight(value: unknown): string | null {
  return typeof value === "string" && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value) ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function updateReason(update: ViewUpdate): string {
  const parts = [];
  if (update.docChanged) parts.push("doc");
  if (update.selectionSet) parts.push("selection");
  if (update.focusChanged) parts.push("focus");
  return parts.join("+") || "update";
}

function originName(origin: unknown): string {
  if (origin == null) return "null";
  if (typeof origin === "string") return origin;
  if (typeof origin === "object") return (origin as any).constructor?.name || "object";
  return typeof origin;
}
