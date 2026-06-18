export type CommentEventKind = "reply" | "resolve" | "reopen";

export interface ThreadAuthorNotification {
  toUid: string;
  title: string;
  body: string;
}

export function buildThreadAuthorNotification(args: {
  kind: CommentEventKind;
  actorUid: string;
  actorName: string;
  authorUid: string;
  fileName: string;
  quote?: string;
  text?: string;
  alreadyNotified?: Set<string>;
}): ThreadAuthorNotification | null {
  if (!args.authorUid || args.authorUid === args.actorUid) return null;
  if (args.alreadyNotified?.has(args.authorUid)) return null;
  const verb =
    args.kind === "reply" ? "replied to your comment in" :
    args.kind === "resolve" ? "resolved your comment in" :
    "reopened your comment in";
  const body = (args.text || args.quote || "").slice(0, 300);
  return {
    toUid: args.authorUid,
    title: `${args.actorName} ${verb} ${args.fileName}`,
    body,
  };
}
