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

export function findFileTreeTitle(doc: Document, fullPath: string): HTMLElement | null {
  return doc.querySelector(
    `.nav-file-title[data-path="${cssAttributeValue(fullPath)}"]`
  ) as HTMLElement | null;
}

export function appendPresenceHost(
  target: HTMLElement,
  className: string,
  users: PresenceDevice[],
  surface: PresenceSurface
): HTMLElement {
  const doc = target.ownerDocument || document;
  const host = doc.createElement("span");
  host.className = className;
  renderPresenceAvatars(host, users, surface);
  target.appendChild(host);
  return host;
}

export function renderPresenceAvatars(
  parent: HTMLElement,
  users: PresenceDevice[],
  surface: PresenceSurface
): void {
  const doc = parent.ownerDocument || document;
  users.forEach((user, i) => {
    const av = doc.createElement("span");
    av.className = `collab-presence-avatar ${surface}` +
      (i > 0 ? " stacked" : "") +
      (user.isSelf ? " self" : "") +
      (user.hasCaret ? " live" : "") +
      (user.typing ? " typing" : "");
    av.style.backgroundColor = user.color;
    av.textContent = presenceInitial(user.name);
    const label = presenceLabel(user);
    av.setAttribute("aria-label", label);
    av.title = label;
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

function isElementLike(value: unknown): value is HTMLElement {
  return !!value && typeof value === "object" && "querySelector" in value && "appendChild" in value;
}
