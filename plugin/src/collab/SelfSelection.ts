import { RangeSetBuilder } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";

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
    height: "1.15em",
    borderLeft: "2px solid",
    marginLeft: "-1px",
    marginRight: "-1px",
    verticalAlign: "text-top",
    pointerEvents: "none",
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
    const from = Math.min(sel.from, sel.to);
    const to = Math.max(sel.from, sel.to);
    const color = this.user.color || "var(--interactive-accent)";
    if (to > from) {
      builder.add(from, to, Decoration.mark({
        class: "cm-collab-self-selection",
        attributes: { style: `background-color: ${alphaColor(color, "44")}` },
      }));
    }
    builder.add(sel.head, sel.head, Decoration.widget({
      side: sel.head >= sel.anchor ? 1 : -1,
      widget: new SelfCaretWidget(this.user.name || "You", color),
    }));
    this.decorations = builder.finish();
  }
}

class SelfCaretWidget extends WidgetType {
  constructor(private name: string, private color: string) {
    super();
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-collab-self-caret";
    el.style.borderColor = this.color;
    const label = document.createElement("span");
    label.className = "cm-collab-self-caret-label";
    label.style.backgroundColor = this.color;
    label.textContent = this.name;
    el.appendChild(label);
    return el;
  }

  eq(other: SelfCaretWidget): boolean {
    return this.name === other.name && this.color === other.color;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function alphaColor(color: string, alphaHex: string): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return `${color}${alphaHex}`;
  return color;
}
