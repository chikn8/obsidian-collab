import {
  renderSelfCaret,
  selfSelectionOverlay,
} from "../src/collab/SelfSelection.ts";
import { renderRemoteCaret } from "../src/collab/CursorAwareness.ts";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentElement = null;
    this.className = "";
    this.textContent = "";
    this.style = {
      setProperty(name, value) {
        this[name] = value;
      },
    };
    this.dataset = {};
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
}

class FakeDocument {
  createElement(tagName) {
    return new FakeElement(tagName, this);
  }
}

console.log("self selection\n");

{
  const overlay = selfSelectionOverlay(4, 4);
  check("collapsed selection renders only a caret", overlay.selection === null && overlay.caret.pos === 4 && overlay.caret.side === 1, JSON.stringify(overlay));
}

{
  const overlay = selfSelectionOverlay(2, 7);
  check("forward selection keeps range and forward caret side", overlay.selection?.from === 2 && overlay.selection?.to === 7 && overlay.caret.pos === 7 && overlay.caret.side === 1, JSON.stringify(overlay));
}

{
  const overlay = selfSelectionOverlay(7, 2);
  check("backward selection keeps range and backward caret side", overlay.selection?.from === 2 && overlay.selection?.to === 7 && overlay.caret.pos === 2 && overlay.caret.side === -1, JSON.stringify(overlay));
}

{
  const doc = new FakeDocument();
  const caret = renderSelfCaret(doc, "Elijah", "#3fbf8f");
  const line = caret.children[0];
  const label = caret.children[1];
  check("self caret uses peer-cursor class", caret.className === "cm-collab-self-caret", caret.className);
  check("self caret line uses device color", line?.className === "cm-collab-self-caret-line" && line.style.borderColor === "#3fbf8f", `${line?.className} ${line?.style.borderColor}`);
  check("self caret label mirrors collaborator label", label?.className === "cm-collab-self-caret-label" && label.textContent === "Elijah", `${label?.className} ${label?.textContent}`);
  check("self caret label uses device color", label?.style.backgroundColor === "#3fbf8f", label?.style.backgroundColor);
}

{
  const doc = new FakeDocument();
  const caret = renderRemoteCaret(doc, "#30bced", "Saket", "peer-1");
  const line = caret.children[0];
  const dot = caret.children[1];
  const label = caret.children[2];
  check("remote caret uses zero-size anchor class", caret.className === "cm-ySelectionCaret", caret.className);
  check("remote caret stores color as CSS variable", caret.style["--collab-cursor-color"] === "#30bced", caret.style["--collab-cursor-color"]);
  check("remote caret stores stable key", caret.dataset.collabCursorKey === "peer-1", caret.dataset.collabCursorKey);
  check("remote caret renders line/dot/label without text nodes", line?.className === "cm-ySelectionCaretLine" && dot?.className === "cm-ySelectionCaretDot" && label?.className === "cm-ySelectionInfo" && label.textContent === "Saket" && caret.children.length === 3, caret.children.map((c) => c.className).join(","));
}

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
