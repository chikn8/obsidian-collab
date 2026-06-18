import { EditorView, Decoration, DecorationSet } from "@codemirror/view";
import { StateField, StateEffect, Extension } from "@codemirror/state";
import type { CommentStore } from "./CommentStore";

/**
 * CM6 layer that highlights commented text ranges in the active editor and
 * routes clicks to open the thread. Composes into the same collabCompartment
 * as yCollab (perf-gated to the one bound editor).
 *
 * Decorations live in a StateField so they MAP through edits (local + remote
 * yCollab transactions) between recomputes; the CommentSession recomputes from
 * the store's RelativePosition anchors whenever comments change or the doc edits.
 */
const setCommentDecos = StateEffect.define<DecorationSet>();

const commentField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decos, tr) {
    decos = decos.map(tr.changes);
    for (const e of tr.effects) if (e.is(setCommentDecos)) decos = e.value;
    return decos;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const commentTheme = EditorView.baseTheme({
  ".cm-collab-comment": {
    backgroundColor: "rgba(255, 206, 84, 0.28)",
    borderBottom: "2px solid rgba(255, 206, 84, 0.9)",
    cursor: "pointer",
  },
  ".cm-collab-comment-resolved": {
    backgroundColor: "transparent",
    borderBottom: "1px dotted var(--text-faint)",
  },
});

interface RangeHit { id: string; from: number; to: number; }

/**
 * Manages comment decorations + click routing for one bound editor.
 * Construct it, include `.extension()` in the bind reconfigure, then `attach(view)`.
 */
export class CommentSession {
  private view: EditorView | null = null;
  private ranges: RangeHit[] = [];
  private unobserve: (() => void) | null = null;

  constructor(
    private store: CommentStore,
    private onOpenThread: (threadId: string) => void,
    private opts: { showResolved: () => boolean } = { showResolved: () => false }
  ) {}

  extension(): Extension {
    return [
      commentField,
      commentTheme,
      EditorView.domEventHandlers({
        mousedown: (evt, view) => this.handleClick(evt, view),
      }),
      EditorView.updateListener.of((u) => {
        // Keep click hit-testing aligned after edits (decos themselves map automatically).
        if (u.docChanged) this.recompute();
      }),
    ];
  }

  attach(view: EditorView): void {
    this.view = view;
    this.unobserve = this.store.observe(() => this.recompute());
    this.recompute();
  }

  detach(): void {
    this.unobserve?.();
    this.unobserve = null;
    this.view = null;
    this.ranges = [];
  }

  /** Scroll/select a thread's anchor in the editor (jump-to-comment). */
  reveal(threadId: string): void {
    const hit = this.ranges.find((r) => r.id === threadId);
    if (!hit || !this.view) return;
    this.view.dispatch({
      selection: { anchor: hit.from, head: hit.to },
      effects: EditorView.scrollIntoView(hit.from, { y: "center" }),
    });
    this.view.focus();
  }

  recompute(): void {
    if (!this.view) return;
    const docLen = this.view.state.doc.length;
    const threads = this.store.list();
    const showResolved = this.opts.showResolved();
    const builder: { from: number; to: number; deco: Decoration }[] = [];
    const hits: RangeHit[] = [];
    for (const t of threads) {
      if (!t.anchor || t.anchor.lost) continue; // orphaned → shown only in the sidebar
      if (t.resolved && !showResolved) continue;
      const from = Math.min(t.anchor.from, docLen);
      const to = Math.min(t.anchor.to, docLen);
      if (to <= from) continue; // zero-width → nothing to mark (sidebar still lists it)
      const cls = t.resolved ? "cm-collab-comment-resolved" : "cm-collab-comment";
      builder.push({ from, to, deco: Decoration.mark({ class: cls, attributes: { "data-thread": t.id } }) });
      hits.push({ id: t.id, from, to });
    }
    builder.sort((a, b) => a.from - b.from || a.to - b.to);
    this.ranges = hits;
    const set = Decoration.set(builder.map((b) => b.deco.range(b.from, b.to)), true);
    this.view.dispatch({ effects: setCommentDecos.of(set) });
  }

  private handleClick(evt: MouseEvent, view: EditorView): void {
    const pos = view.posAtCoords({ x: evt.clientX, y: evt.clientY });
    if (pos == null) return;
    // innermost (smallest) range containing pos wins
    let best: RangeHit | null = null;
    for (const r of this.ranges) {
      if (pos >= r.from && pos <= r.to) {
        if (!best || r.to - r.from < best.to - best.from) best = r;
      }
    }
    if (best) {
      evt.preventDefault();
      this.onOpenThread(best.id);
    }
  }
}
