import { Compartment, Extension, EditorSelection, EditorState, Facet } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { cursorAwarenessExtension } from "./CursorAwareness";
import {
  applyBindContentPlanToYText,
  planBindContentReconcile,
  shouldRetryBindContentReconcile,
} from "./EditorBindReconcile";
import { clearUnboundEditorContent, matchesUnboundEditorContent } from "./EditorBindStash";
import { err, trace } from "../utils/log";

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

function replaceViewContent(view: EditorView, content: string): void {
  const docLen = view.state.doc.length;
  const clamp = (pos: number) => Math.max(0, Math.min(content.length, pos));
  const selection = EditorSelection.create(
    view.state.selection.ranges.map((range) => EditorSelection.range(clamp(range.anchor), clamp(range.head))),
    Math.min(view.state.selection.mainIndex, view.state.selection.ranges.length - 1)
  );
  view.dispatch({
    changes: { from: 0, to: docLen, insert: content },
    selection,
  });
}

const BIND_RECONCILE_SETTLE_MS = 250;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function reconcileEditorBeforeBind(
  view: EditorView,
  ytext: Y.Text,
  path?: string,
  viewLooksPristine?: (viewText: string) => boolean,
  isStillCurrent?: () => boolean
): Promise<boolean> {
  let viewText = view.state.doc.toString();
  let yText = ytext.toString();
  if (viewText === yText) return true;

  const planForCurrentContent = () => {
    const looksPristine = viewLooksPristine?.(viewText) ?? false;
    return planBindContentReconcile(
      yText,
      viewText,
      looksPristine,
      !looksPristine && !!path && matchesUnboundEditorContent(path, viewText)
    );
  };
  let plan = planForCurrentContent();
  if (shouldRetryBindContentReconcile(plan)) {
    trace("bind", "bind-content-settle-retry", {
      path,
      viewLen: viewText.length,
      yLen: yText.length,
      applied: plan.applied,
    });
    await delay(BIND_RECONCILE_SETTLE_MS);
    if (!view.dom.isConnected || (isStillCurrent && !isStillCurrent())) {
      trace("bind", "bind-content-settle-abort", { path, applied: plan.applied });
      return false;
    }
    viewText = view.state.doc.toString();
    yText = ytext.toString();
    if (viewText === yText) return true;
    plan = planForCurrentContent();
  }

  trace("bind", "bind-content-mismatch", {
    path,
    viewLen: viewText.length,
    yLen: yText.length,
    applied: plan.applied,
  });
  err("bind", "editor buffer diverged from synced doc", path || "", {
    viewLen: viewText.length,
    yLen: yText.length,
    applied: plan.applied,
  });

  if (plan.action === "view-diff") applyBindContentPlanToYText(ytext, plan);
  else replaceViewContent(view, yText);

  if (view.state.doc.toString() !== ytext.toString()) replaceViewContent(view, ytext.toString());
  return true;
}

export function bindEditor(
  view: EditorView,
  ytext: Y.Text,
  awareness: Awareness,
  path?: string,
  extra: Extension[] = []
): void {
  if (view.state.doc.toString() !== ytext.toString()) replaceViewContent(view, ytext.toString());
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
  if (path) clearUnboundEditorContent(path);
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
