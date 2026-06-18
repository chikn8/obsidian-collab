export interface MentionUser {
  uid: string;
  uids?: string[];
  name: string;
}

export interface MentionToken {
  from: number;
  to: number;
  query: string;
  quoted: boolean;
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

function lower(name: string): string {
  return normalizeName(name).toLocaleLowerCase();
}

export function findMentionedUsers(text: string, users: MentionUser[]): MentionUser[] {
  if (!text.includes("@")) return [];
  const found: MentionUser[] = [];
  for (const user of groupedMentionUsers(users)) {
    const name = normalizeName(user.name);
    if (!name) continue;
    const quoted = text.toLocaleLowerCase().includes(`@"${name.toLocaleLowerCase()}"`);
    const bare = !/\s/.test(name) && new RegExp(`(^|[^A-Za-z0-9_-])@${escapeRegExp(name)}(?=$|[^A-Za-z0-9_-])`, "i").test(text);
    if (quoted || bare) found.push(user);
  }
  return found;
}

export function mentionTokenAt(text: string, cursor: number): MentionToken | null {
  const before = text.slice(0, cursor);
  const quoted = /@"([^"\n]*)$/.exec(before);
  if (quoted?.index !== undefined) {
    return { from: quoted.index, to: cursor, query: quoted[1], quoted: true };
  }
  const bare = /(^|[\s([{:])@([^\s@"'`,.;:!?()[\]{}<>]*)$/.exec(before);
  if (!bare) return null;
  const prefixLen = bare[1]?.length ?? 0;
  return { from: bare.index + prefixLen, to: cursor, query: bare[2] ?? "", quoted: false };
}

export function matchingMentionUsers(users: MentionUser[], query: string, limit = 6): MentionUser[] {
  const q = lower(query);
  const matches: MentionUser[] = [];
  for (const user of groupedMentionUsers(users)) {
    const name = normalizeName(user.name);
    if (!name) continue;
    if (!q || lower(name).includes(q)) {
      matches.push({ ...user, name });
    }
    if (matches.length >= limit) break;
  }
  return matches;
}

export function mentionTextFor(user: MentionUser): string {
  const name = normalizeName(user.name);
  return /\s/.test(name) ? `@"${name}" ` : `@${name} `;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function groupedMentionUsers(users: MentionUser[]): MentionUser[] {
  const byName = new Map<string, MentionUser>();
  for (const user of users) {
    const name = normalizeName(user.name);
    if (!name) continue;
    const key = lower(name);
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, { ...user, name, uids: user.uids?.length ? [...user.uids] : [user.uid] });
      continue;
    }
    const ids = new Set(existing.uids || [existing.uid]);
    for (const uid of user.uids || [user.uid]) ids.add(uid);
    existing.uids = Array.from(ids);
  }
  return Array.from(byName.values());
}
