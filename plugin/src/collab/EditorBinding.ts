import { Compartment, Extension, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";

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
  extra: Extension[] = []
): void {
  // yCollab returns an array; append extra layers (e.g. comments) AFTER it so
  // yUndoManager/ySync ordering inside yCollab is preserved.
  view.dispatch({
    effects: collabCompartment.reconfigure([yCollab(ytext, awareness), ...extra]),
  });
}

export function unbindEditor(view: EditorView): void {
  view.dispatch({ effects: collabCompartment.reconfigure([]) });
}

/**
 * Read-only extensions for viewer/commenter roles: local keystrokes are inert
 * while remote edits + remote cursors still render (yCollab applies them
 * regardless of editability). The server is the real boundary; this is UX.
 */
export function readOnlyExtension(): Extension {
  return [EditorState.readOnly.of(true), EditorView.editable.of(false)];
}
