import {
  appendPresenceHost,
  clearRenderedPresence,
  findFileTreeTitle,
  renderPresenceAvatars,
  renderedPresenceConnected,
  tabHeaderForLeaf,
  tabPresenceTarget,
} from "../src/collab/PresenceDom.ts";
import { renderFacepileRoster } from "../src/collab/Presence.ts";

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
    this.attributes = new Map();
    this.style = {};
    this.className = "";
    this.textContent = "";
    this.title = "";
    this.classList = {
      add: (...names) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        for (const name of names) classes.add(name);
        this.className = Array.from(classes).join(" ");
      },
      remove: (...names) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        for (const name of names) classes.delete(name);
        this.className = Array.from(classes).join(" ");
      },
      contains: (name) => this.className.split(/\s+/).includes(name),
    };
  }

  replaceChildren(...children) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    for (const child of children) this.appendChild(child);
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    const index = siblings.indexOf(this);
    if (index >= 0) siblings.splice(index, 1);
    this.parentElement = null;
  }

  setAttribute(key, value) {
    this.attributes.set(key, String(value));
  }

  getAttribute(key) {
    return this.attributes.get(key) ?? null;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matches(child, selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
}

class FakeDocument extends FakeElement {
  constructor() {
    super("#document", null);
    this.ownerDocument = this;
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }
}

function matches(el, selector) {
  const classMatch = selector.match(/^\.([A-Za-z0-9_-]+)/);
  if (classMatch) {
    const cls = classMatch[1];
    if (!el.className.split(/\s+/).includes(cls)) return false;
  }
  const pathMatch = selector.match(/\[data-path="((?:\\.|[^"])*)"\]/);
  if (!classMatch && !pathMatch) return false;
  if (!pathMatch) return true;
  return el.getAttribute("data-path") === unescapeCssAttribute(pathMatch[1]);
}

function unescapeCssAttribute(value) {
  return value
    .replace(/\\a /g, "\n")
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\");
}

const users = [
  {
    presenceKey: "u1:desktop",
    uid: "u1",
    deviceId: "desktop",
    name: "Elijah",
    color: "#4c7dff",
    baseColor: "#4c7dff",
    device: "desktop",
    activeFile: "Note.md",
    typing: true,
    hasCaret: true,
    isSelf: true,
  },
  {
    presenceKey: "u1:phone",
    uid: "u1",
    deviceId: "phone",
    name: "Elijah",
    color: "#3fbf8f",
    baseColor: "#4c7dff",
    device: "mobile",
    activeFile: "Note.md",
    typing: false,
    hasCaret: false,
    isSelf: false,
  },
];

console.log("presence dom\n");

{
  const doc = new FakeDocument();
  const parent = doc.createElement("span");
  renderPresenceAvatars(parent, users, "file");

  const first = parent.children[0];
  const second = parent.children[1];
  check("renders one avatar per device", parent.children.length === 2);
  check("self/live/typing classes are preserved", /self/.test(first.className) && /live/.test(first.className) && /typing/.test(first.className), first.className);
  check("later avatars stack without changing layout", /stacked/.test(second.className), second.className);
  check("avatar title is hover-readable", first.title === "Elijah (desktop) (you) - typing", first.title);
  check("avatar aria mirrors title", first.getAttribute("aria-label") === first.title);
  check("typing pill has three dots", first.children[0]?.className === "collab-typing-pill" && first.children[0].children.length === 3);
}

{
  const doc = new FakeDocument();
  const parent = doc.createElement("div");
  let jumped = null;
  renderFacepileRoster(parent, users, (key) => { jumped = key; });

  const self = parent.children[0];
  const remoteViewing = parent.children[1];
  check("facepile self avatar is an inert hover target", self.tagName === "SPAN" && self.getAttribute("role") === "img" && self.title.includes("(you)"), self.tagName);
  check("facepile viewing avatar is not disabled", remoteViewing.tagName === "SPAN" && !remoteViewing.disabled && remoteViewing.title === "Elijah (mobile) - viewing", remoteViewing.title);

  const remoteCaret = { ...users[1], hasCaret: true };
  renderFacepileRoster(parent, [remoteCaret], (key) => { jumped = key; });
  const button = parent.children[0];
  button.onclick?.();
  check("facepile remote caret avatar is clickable", button.tagName === "BUTTON" && button.type === "button" && jumped === remoteCaret.presenceKey);
}

{
  const doc = new FakeDocument();
  const parent = doc.createElement("span");
  let followed = null;
  renderPresenceAvatars(parent, users, "file", (user) => { followed = user; });

  const first = parent.children[0];
  const second = parent.children[1];
  check("self avatar is not followable", !first.classList.contains("followable") && !first.onclick);
  check("remote avatar advertises follow action", second.classList.contains("followable") && second.title === "Elijah (mobile) - viewing - click to open", second.title);
  check("follow avatar aria mirrors title", second.getAttribute("aria-label") === second.title);

  let prevented = false;
  let stopped = false;
  second.onclick?.({
    preventDefault() { prevented = true; },
    stopPropagation() { stopped = true; },
  });
  check("clicking remote avatar follows active file", followed === users[1] && prevented && stopped);
}

{
  const doc = new FakeDocument();
  const parent = doc.createElement("span");
  const openOnly = { ...users[0], typing: false, hasCaret: false, dimmed: true };
  renderPresenceAvatars(parent, [openOnly], "tab");
  const first = parent.children[0];
  check("open-but-unfocused avatar is dimmed", first.classList.contains("dimmed"), first.className);
  check("open-but-unfocused label says open", first.title === "Elijah (desktop) (you) - open", first.title);
}

{
  const doc = new FakeDocument();
  const title = doc.createElement("div");
  const host = appendPresenceHost(title, "collab-file-presence-host", users, "file");
  const rendered = new Map([["Shared/Note.md", [host]]]);
  check("presence host appends to target", title.children[0] === host && host.children.length === 2);
  check("mounted presence host is connected", renderedPresenceConnected(rendered) === true);
  clearRenderedPresence(rendered);
  check("clearRenderedPresence removes hosts", title.children.length === 0 && rendered.size === 0);
  check("detached presence host is not connected", renderedPresenceConnected(new Map([["Shared/Note.md", [host]]])) === false);
}

{
  const doc = new FakeDocument();
  const stale = doc.createElement("span");
  stale.isConnected = false;
  check("explicitly disconnected host is not connected", renderedPresenceConnected(new Map([["Shared/Note.md", [stale]]])) === false);
}

{
  const doc = new FakeDocument();
  const row = doc.createElement("div");
  const path = "Shared/quote \"note\".md";
  row.className = "nav-file-title";
  row.setAttribute("data-path", path);
  doc.appendChild(row);
  check("file-tree lookup handles quoted paths", findFileTreeTitle(doc, path) === row);
}

{
  const doc = new FakeDocument();
  const wrapper = doc.createElement("div");
  const row = doc.createElement("div");
  const path = "Shared/wrapped.md";
  wrapper.setAttribute("data-path", path);
  row.className = "nav-file-title";
  wrapper.appendChild(row);
  doc.appendChild(wrapper);
  check("file-tree lookup handles data-path wrappers", findFileTreeTitle(doc, path) === row);
}

{
  const doc = new FakeDocument();
  const container = doc.createElement("div");
  const header1 = doc.createElement("div");
  const header2 = doc.createElement("div");
  header1.className = "workspace-tab-header";
  header2.className = "workspace-tab-header";
  container.appendChild(header1);
  container.appendChild(header2);
  const leaf1 = {};
  const leaf2 = {};
  const parent = { children: [leaf1, leaf2], containerEl: container };
  leaf1.parent = parent;
  leaf2.parent = parent;
  check("tabHeaderForLeaf falls back by tab index", tabHeaderForLeaf(leaf2) === header2);

  const inner = doc.createElement("div");
  const title = doc.createElement("span");
  inner.className = "workspace-tab-header-inner";
  title.className = "workspace-tab-header-inner-title";
  header2.appendChild(inner);
  inner.appendChild(title);
  check("tabPresenceTarget uses title parent", tabPresenceTarget(header2) === inner);
}

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
