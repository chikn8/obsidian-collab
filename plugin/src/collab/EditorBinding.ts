import { Compartment, Extension, EditorState, Facet } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { cursorAwarenessExtension } from "./CursorAwareness";

/**
 * Binds the *active* editor to a file's Y.Text via y-codemirror.next (yCollab).
 *
 * This is what makes editing buttery: local edits become incremental CRDT ops,
 * remote edits apply straight to the editor state (no whole-file vault.modify
 * round-trip / reload), and remote cursors/selections render natively
 * (.cm-ySelection* — styled in styles.css).
 *
 * Only ONE editor is bound at a time (the focused note). Background synced
 * files keep the headless FileProvider disk-sync. A single CM6 Compartment,
 * registered globally, is reconfigured per active file.
 */
const collabCompartment = new Compartment();
const collabBindingPath = Facet.define<string, string>({
  combine: (values) => values[values.length - 1] || "",
});

/** Register once via plugin.registerEditorExtension(). Starts empty. */
export const collabEditorExtension = collabCompartment.of([]);

/** Resolve the underlying CM6 EditorView from an Obsidian MarkdownView. */
export function getEditorView(markdownView: any): EditorView | null {
  const cm = markdownView?.editor?.cm;
  return cm instanceof EditorView ? cm : (cm ?? null);
}

export function bindEditor(
  view: EditorView,
  ytext: Y.Text,
  awareness: Awareness,
  path?: string,
  extra: Extension[] = []
): void {
  // yCollab handles text sync/undo. Cursor awareness is local so we can keep
  // identity, focus clearing, and diagnostics under our control.
  view.dispatch({
    effects: collabCompartment.reconfigure([
      collabBindingPath.of(path || ""),
      yCollab(ytext, null),
      cursorAwarenessExtension(ytext, awareness, { label: path }),
      ...extra,
    ]),
  });
}

export function unbindEditor(view: EditorView): void {
  view.dispatch({ effects: collabCompartment.reconfigure([]) });
}

export function currentCollabBindingPath(view: EditorView): string | null {
  return view.state.facet(collabBindingPath) || null;
}

/**
 * Read-only extensions for viewer/commenter roles: local keystrokes are inert
 * while remote edits + remote cursors still render (yCollab applies them
 * regardless of editability). The server is the real boundary; this is UX.
 */
export function readOnlyExtension(): Extension {
  return [EditorState.readOnly.of(true), EditorView.editable.of(false)];
}
