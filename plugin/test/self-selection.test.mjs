import {
  renderSelfCaret,
  selfSelectionOverlay,
} from "../src/collab/SelfSelection.ts";

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
    this.style = {};
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
  const label = caret.children[0];
  check("self caret uses peer-cursor class", caret.className === "cm-collab-self-caret", caret.className);
  check("self caret uses device color", caret.style.borderColor === "#3fbf8f", caret.style.borderColor);
  check("self caret label mirrors collaborator label", label?.className === "cm-collab-self-caret-label" && label.textContent === "Elijah", `${label?.className} ${label?.textContent}`);
  check("self caret label uses device color", label?.style.backgroundColor === "#3fbf8f", label?.style.backgroundColor);
}

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
