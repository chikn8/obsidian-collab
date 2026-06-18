import type { ThreadView } from "../collab/CommentStore";

export interface CommentActivity {
  at: number;
  byUid: string;
  byName: string;
  text: string;
}

export function latestCommentActivity(thread: ThreadView): CommentActivity {
  const latest = thread.replies.reduce<CommentActivity | null>((best, reply) => {
    if (best && best.at >= reply.at) return best;
    return { at: reply.at || 0, byUid: reply.byUid || "", byName: reply.byName || "", text: reply.text || "" };
  }, null);
  return latest || {
    at: thread.createdAt || 0,
    byUid: thread.authorUid || "",
    byName: thread.authorName || "",
    text: thread.quote || "",
  };
}

export function isThreadUnread(thread: ThreadView, myUid: string, lastReadAt: number): boolean {
  const latest = latestCommentActivity(thread);
  return !thread.resolved && latest.byUid !== myUid && latest.at > lastReadAt;
}
