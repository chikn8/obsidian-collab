import { RangeSetBuilder } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";

export interface SelfSelectionOverlay {
  selection: { from: number; to: number } | null;
  caret: { pos: number; side: -1 | 1 };
}

export function selfSelectionOverlay(anchor: number, head: number): SelfSelectionOverlay {
  const from = Math.min(anchor, head);
  const to = Math.max(anchor, head);
  return {
    selection: to > from ? { from, to } : null,
    caret: {
      pos: head,
      side: head >= anchor ? 1 : -1,
    },
  };
}

export function selfSelectionExtension(user: { name: string; color: string }): Extension {
  return [
    selfSelectionTheme,
    ViewPlugin.define((view) => new SelfSelectionPlugin(view, user), {
      decorations: (v) => v.decorations,
    }),
  ];
}

const selfSelectionTheme = EditorView.baseTheme({
  ".cm-collab-self-selection": {
    opacity: "0.35",
  },
  ".cm-collab-self-caret": {
    display: "inline-block",
    position: "relative",
    width: "0",
    height: "0",
    lineHeight: "0",
    marginLeft: "-1px",
    marginRight: "-1px",
    verticalAlign: "text-top",
    pointerEvents: "none",
    overflow: "visible",
  },
  ".cm-collab-self-caret-line": {
    position: "absolute",
    left: "0",
    top: "0",
    height: "1.15em",
    borderLeft: "2px solid",
  },
  ".cm-collab-self-caret-label": {
    position: "absolute",
    top: "-1.45em",
    left: "-1px",
    padding: "1px 4px",
    borderRadius: "3px 3px 3px 0",
    color: "white",
    fontFamily: "var(--font-interface)",
    fontSize: "0.72em",
    fontWeight: "600",
    whiteSpace: "nowrap",
    lineHeight: "1.1",
    opacity: "0.92",
  },
});

class SelfSelectionPlugin {
  decorations: DecorationSet = Decoration.none;

  constructor(view: EditorView, private user: { name: string; color: string }) {
    this.rebuild(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) {
      this.rebuild(update.view);
    }
  }

  private rebuild(view: EditorView): void {
    const builder = new RangeSetBuilder<Decoration>();
    const sel = view.state.selection.main;
    const overlay = selfSelectionOverlay(sel.anchor, sel.head);
    const color = this.user.color || "var(--interactive-accent)";
    builder.add(overlay.caret.pos, overlay.caret.pos, Decoration.widget({
      side: overlay.caret.side,
      widget: new SelfCaretWidget(this.user.name || "You", color),
    }));
    this.decorations = builder.finish();
  }
}

class SelfCaretWidget extends WidgetType {
  constructor(private name: string, private color: string) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    return renderSelfCaret(view.dom.ownerDocument || document, this.name, this.color);
  }

  eq(other: SelfCaretWidget): boolean {
    return this.name === other.name && this.color === other.color;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export function renderSelfCaret(doc: Document, name: string, color: string): HTMLElement {
  const el = doc.createElement("span");
  el.className = "cm-collab-self-caret";
  const line = doc.createElement("span");
  line.className = "cm-collab-self-caret-line";
  line.style.borderColor = color;
  el.appendChild(line);
  const label = doc.createElement("span");
  label.className = "cm-collab-self-caret-label";
  label.style.backgroundColor = color;
  label.textContent = name;
  el.appendChild(label);
  return el;
}
