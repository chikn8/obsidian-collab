export interface MentionUser {
  uid: string;
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
  const seen = new Set<string>();
  for (const user of users) {
    const name = normalizeName(user.name);
    if (!name || seen.has(user.uid)) continue;
    const quoted = text.toLocaleLowerCase().includes(`@"${name.toLocaleLowerCase()}"`);
    const bare = !/\s/.test(name) && new RegExp(`(^|[^A-Za-z0-9_-])@${escapeRegExp(name)}(?=$|[^A-Za-z0-9_-])`, "i").test(text);
    if (quoted || bare) {
      seen.add(user.uid);
      found.push(user);
    }
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
  const seen = new Set<string>();
  const matches: MentionUser[] = [];
  for (const user of users) {
    const name = normalizeName(user.name);
    if (!name || seen.has(user.uid)) continue;
    if (!q || lower(name).includes(q)) {
      seen.add(user.uid);
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
