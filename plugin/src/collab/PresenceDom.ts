import {
  presenceInitial,
  presenceLabel,
  type PresenceDevice,
} from "./PresenceModel";

export type PresenceSurface = "file" | "tab";

export function clearRenderedPresence(rendered: Map<string, HTMLElement[]>): void {
  for (const els of rendered.values()) {
    for (const el of els) el.remove();
  }
  rendered.clear();
}

export function renderedPresenceConnected(rendered: Map<string, HTMLElement[]>): boolean {
  for (const els of rendered.values()) {
    if (els.length === 0) return false;
    for (const el of els) {
      const isConnected = (el as any).isConnected;
      if (typeof isConnected === "boolean") {
        if (!isConnected) return false;
      } else if (!el.parentElement) {
        return false;
      }
    }
  }
  return true;
}

export function findFileTreeTitle(doc: Document, fullPath: string): HTMLElement | null {
  const pathSelector = `[data-path="${cssAttributeValue(fullPath)}"]`;
  const direct = doc.querySelector(`.nav-file-title${pathSelector}`) as HTMLElement | null;
  if (direct) return direct;
  const carrier = doc.querySelector(pathSelector) as HTMLElement | null;
  if (!carrier) return null;
  if (hasClass(carrier, "nav-file-title")) return carrier;
  const nested = carrier.querySelector?.(".nav-file-title") as HTMLElement | null;
  if (nested) return nested;
  const parentTitle = closestByClass(carrier, "nav-file-title");
  return parentTitle || carrier;
}

export function appendPresenceHost(
  target: HTMLElement,
  className: string,
  users: PresenceDevice[],
  surface: PresenceSurface,
  onFollow?: (user: PresenceDevice) => void
): HTMLElement {
  const doc = target.ownerDocument || document;
  const host = doc.createElement("span");
  host.className = className;
  renderPresenceAvatars(host, users, surface, onFollow);
  target.appendChild(host);
  return host;
}

export function renderPresenceAvatars(
  parent: HTMLElement,
  users: PresenceDevice[],
  surface: PresenceSurface,
  onFollow?: (user: PresenceDevice) => void
): void {
  const doc = parent.ownerDocument || document;
  users.forEach((user, i) => {
    const av = doc.createElement("span");
    av.className = `collab-presence-avatar ${surface}` +
      (i > 0 ? " stacked" : "") +
      (user.isSelf ? " self" : "") +
      (user.hasCaret ? " live" : "") +
      (user.typing ? " typing" : "") +
      (user.dimmed ? " dimmed" : "");
    av.style.backgroundColor = user.color;
    av.textContent = presenceInitial(user.name);
    const label = presenceLabel(user);
    let title = label;
    if (onFollow && user.activeFile && !user.isSelf) {
      av.classList.add("followable");
      title = `${label} - click to open`;
      av.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        onFollow(user);
      };
    }
    av.setAttribute("aria-label", title);
    av.title = title;
    if (user.typing) av.appendChild(makeTypingDots(doc));
    parent.appendChild(av);
  });
}

export function makeTypingDots(doc: Document = document): HTMLElement {
  const pill = doc.createElement("span");
  pill.className = "collab-typing-pill";
  for (let i = 0; i < 3; i++) {
    const dot = doc.createElement("span");
    pill.appendChild(dot);
  }
  return pill;
}

export function tabHeaderForLeaf(leaf: any): HTMLElement | null {
  const direct = leaf?.tabHeaderEl || leaf?.tabHeader?.el || leaf?.tabHeaderInnerTitleEl?.parentElement?.parentElement;
  if (isElementLike(direct)) return direct as HTMLElement;

  const parent = leaf?.parent;
  const children = Array.isArray(parent?.children) ? parent.children : Array.isArray(parent?.leaves) ? parent.leaves : [];
  const idx = children.indexOf(leaf);
  const container = parent?.containerEl;
  if (idx < 0 || !isElementLike(container)) return null;
  const headers = Array.from((container as HTMLElement).querySelectorAll(".workspace-tab-header"));
  const header = headers[idx];
  return isElementLike(header) ? header as HTMLElement : null;
}

export function tabPresenceTarget(header: HTMLElement): HTMLElement {
  return (
    (header.querySelector(".workspace-tab-header-inner-title") as HTMLElement | null)?.parentElement ||
    (header.querySelector(".workspace-tab-header-inner") as HTMLElement | null) ||
    header
  );
}

function cssAttributeValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/\n/g, "\\a ");
}

function hasClass(el: HTMLElement, className: string): boolean {
  const classList = (el as any).classList;
  if (classList?.contains?.(className)) return true;
  return (el.className || "").split(/\s+/).includes(className);
}

function closestByClass(el: HTMLElement, className: string): HTMLElement | null {
  let cur: HTMLElement | null = el.parentElement;
  while (cur) {
    if (hasClass(cur, className)) return cur;
    cur = cur.parentElement;
  }
  return null;
}

function isElementLike(value: unknown): value is HTMLElement {
  return !!value && typeof value === "object" && "querySelector" in value && "appendChild" in value;
}
