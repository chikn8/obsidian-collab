import { matchingMentionUsers, mentionTextFor, mentionTokenAt, type MentionUser } from "../utils/mentions";

export function wireMentionAutocomplete(
  host: HTMLElement,
  input: HTMLInputElement,
  usersProvider: () => MentionUser[]
): void {
  const menu = host.createDiv({ cls: "collab-mention-menu" });
  let active = 0;
  let visible = false;

  const close = () => {
    visible = false;
    menu.empty();
    menu.removeClass("is-open");
  };

  const currentUsers = (): MentionUser[] =>
    matchingMentionUsers(usersProvider(), mentionTokenAt(input.value, input.selectionStart ?? input.value.length)?.query ?? "");

  const insert = (user: MentionUser) => {
    const token = mentionTokenAt(input.value, input.selectionStart ?? input.value.length);
    if (!token) return;
    const mention = mentionTextFor(user);
    input.value = input.value.slice(0, token.from) + mention + input.value.slice(token.to);
    const pos = token.from + mention.length;
    input.setSelectionRange(pos, pos);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    close();
  };

  const render = () => {
    const token = mentionTokenAt(input.value, input.selectionStart ?? input.value.length);
    const users = token ? matchingMentionUsers(usersProvider(), token.query) : [];
    menu.empty();
    if (!token || users.length === 0) { close(); return; }
    visible = true;
    active = Math.min(active, users.length - 1);
    menu.addClass("is-open");
    users.forEach((user, index) => {
      const item = menu.createEl("button", { type: "button", cls: "collab-mention-item" + (index === active ? " active" : "") });
      item.createSpan({ text: user.name, cls: "collab-mention-name" });
      item.onclick = (e) => { e.preventDefault(); insert(user); input.focus(); };
    });
  };

  input.addEventListener("input", () => { active = 0; render(); });
  input.addEventListener("click", render);
  input.addEventListener("blur", () => setTimeout(close, 120));
  input.addEventListener("keydown", (e) => {
    if (!visible) return;
    const users = currentUsers();
    if (users.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      active = (active + 1) % users.length;
      render();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      active = (active - 1 + users.length) % users.length;
      render();
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      e.stopImmediatePropagation();
      insert(users[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });
}
