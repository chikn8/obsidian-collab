import * as Y from "yjs";

/**
 * Threaded comments for one file, stored as a sibling `Y.Map('comments')` on the
 * SAME per-file Y.Doc as the `codemirror` Y.Text. Rides the existing file room /
 * provider / auth with ZERO server change; persists via encodeStateAsUpdate;
 * offline via IndexedDB; excluded from git snapshots (those read only 'codemirror').
 *
 * Each thread is a nested Y.Map so concurrent edits MERGE (two people replying,
 * or resolve+reply at once, both apply) instead of last-write-wins clobbering.
 *
 *   comments: Y.Map<threadId, Y.Map {
 *     anchorFrom, anchoric to: relative-position JSON strings (track the text),
 *     quote:   the anchored excerpt (fallback when the range is deleted),
 *     resolved: boolean,
 *     authorUid, authorName, createdAt,
 *     replies: Y.Array<Y.Map { id, byUid, byName, at, text, reactions: Y.Map<emoji,count> }>
 *   }>
 */

export interface ResolvedAnchor {
  from: number;
  to: number;
  lost: boolean; // true when the anchored text was deleted (collapsed/missing)
}

export interface ThreadView {
  id: string;
  anchor: ResolvedAnchor | null;
  quote: string;
  resolved: boolean;
  authorUid: string;
  authorName: string;
  createdAt: number;
  replies: ReplyView[];
}
export interface ReplyView {
  id: string;
  byUid: string;
  byName: string;
  at: number;
  text: string;
  reactions: Record<string, number>;
}

let _seq = 0;
function genId(): string {
  // unique enough within a doc; Math.random is unavailable in some sandboxes,
  // so combine crypto when present with a monotonic counter.
  const rnd = (globalThis.crypto?.randomUUID?.() as string) || `r${++_seq}`;
  return rnd.replace(/-/g, "").slice(0, 16);
}

export class CommentStore {
  readonly doc: Y.Doc;
  readonly ytext: Y.Text;
  readonly map: Y.Map<any>;

  constructor(doc: Y.Doc) {
    this.doc = doc;
    this.ytext = doc.getText("codemirror");
    this.map = doc.getMap("comments");
  }

  /** Deep-observe all thread/reply changes. Returns an unsubscribe fn. */
  observe(cb: () => void): () => void {
    const handler = () => cb();
    this.map.observeDeep(handler);
    return () => this.map.unobserveDeep(handler);
  }

  // ── anchors ────────────────────────────────────────────────────────────────
  private encodeAnchor(index: number): string {
    const rp = Y.createRelativePositionFromTypeIndex(this.ytext, index);
    return JSON.stringify(Y.relativePositionToJSON(rp));
  }
  private decodeAnchor(json: string): number | null {
    try {
      const rp = Y.createRelativePositionFromJSON(JSON.parse(json));
      const abs = Y.createAbsolutePositionFromRelativePosition(rp, this.doc);
      return abs ? abs.index : null; // null when the anchored type/region is gone
    } catch {
      return null;
    }
  }

  /** Resolve a thread's stored anchor to current absolute offsets (or lost). */
  resolveAnchor(thread: Y.Map<any>): ResolvedAnchor | null {
    const fromJson = thread.get("anchorFrom");
    const toJson = thread.get("anchorTo");
    if (!fromJson || !toJson) return null;
    const quote: string = thread.get("quote") || "";
    const from = this.decodeAnchor(fromJson);
    const to = this.decodeAnchor(toJson);
    if (from == null || to == null) return this.rematchByQuote(quote);
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);

    // Verify the resolved range still holds the anchored quote. When the
    // commented text is deleted, a Yjs anchor can collapse to offset 0 and would
    // otherwise highlight UNRELATED text at the file start. If the range no
    // longer matches the quote, fall back to a quote search (re-anchor if the
    // text just moved; mark orphaned if it's truly gone).
    if (quote) {
      const slice = this.ytext.toString().slice(lo, hi);
      if (slice !== quote) return this.rematchByQuote(quote);
    }
    return { from: lo, to: hi, lost: lo === hi };
  }

  /** Locate a thread's quote in the current text; re-anchor there, or mark lost. */
  private rematchByQuote(quote: string): ResolvedAnchor {
    if (!quote) return { from: 0, to: 0, lost: true };
    const idx = this.ytext.toString().indexOf(quote);
    if (idx >= 0) return { from: idx, to: idx + quote.length, lost: false };
    return { from: 0, to: 0, lost: true };
  }

  // ── mutations ────────────────────────────────────────────────────────────────
  addThread(args: {
    from: number;
    to: number;
    quote: string;
    authorUid: string;
    authorName: string;
    text: string;
    at: number;
  }): string {
    const id = genId();
    this.doc.transact(() => {
      const thread = new Y.Map<any>();
      thread.set("anchorFrom", this.encodeAnchor(args.from));
      thread.set("anchorTo", this.encodeAnchor(args.to));
      thread.set("quote", args.quote);
      thread.set("resolved", false);
      thread.set("authorUid", args.authorUid);
      thread.set("authorName", args.authorName);
      thread.set("createdAt", args.at);
      const replies = new Y.Array<any>();
      thread.set("replies", replies);
      this.map.set(id, thread);
      // The opening comment text is the first reply, so the thread always has a body.
      this.appendReply(thread, args);
    });
    return id;
  }

  addReply(threadId: string, args: { byUid: string; byName: string; text: string; at: number }): void {
    const thread = this.map.get(threadId) as Y.Map<any> | undefined;
    if (!thread) return;
    this.doc.transact(() => this.appendReply(thread, { authorUid: args.byUid, authorName: args.byName, text: args.text, at: args.at }));
  }

  private appendReply(thread: Y.Map<any>, args: { authorUid: string; authorName: string; text: string; at: number }): void {
    const replies = thread.get("replies") as Y.Array<any>;
    const reply = new Y.Map<any>();
    reply.set("id", genId());
    reply.set("byUid", args.authorUid);
    reply.set("byName", args.authorName);
    reply.set("at", args.at);
    reply.set("text", args.text);
    reply.set("reactions", new Y.Map<any>());
    replies.push([reply]);
  }

  setResolved(threadId: string, resolved: boolean): void {
    const thread = this.map.get(threadId) as Y.Map<any> | undefined;
    if (thread) thread.set("resolved", resolved);
  }

  /** Permanently remove a thread (only its author should call this). */
  deleteThread(threadId: string): void {
    if (this.map.has(threadId)) this.map.delete(threadId);
  }

  react(threadId: string, replyId: string, emoji: string, delta: number): void {
    const thread = this.map.get(threadId) as Y.Map<any> | undefined;
    if (!thread) return;
    const replies = thread.get("replies") as Y.Array<any>;
    for (let i = 0; i < replies.length; i++) {
      const r = replies.get(i) as Y.Map<any>;
      if (r.get("id") === replyId) {
        const reactions = r.get("reactions") as Y.Map<any>;
        const cur = (reactions.get(emoji) as number) || 0;
        const next = Math.max(0, cur + delta);
        if (next === 0) reactions.delete(emoji);
        else reactions.set(emoji, next);
        return;
      }
    }
  }

  // ── reads ────────────────────────────────────────────────────────────────
  list(): ThreadView[] {
    const out: ThreadView[] = [];
    this.map.forEach((thread: Y.Map<any>, id: string) => {
      out.push(this.view(id, thread));
    });
    // newest anchored first; lost/orphaned sink to the bottom
    return out.sort((a, b) => {
      if (!!a.anchor?.lost !== !!b.anchor?.lost) return a.anchor?.lost ? 1 : -1;
      return (a.anchor?.from ?? 0) - (b.anchor?.from ?? 0);
    });
  }

  private view(id: string, thread: Y.Map<any>): ThreadView {
    const replies = (thread.get("replies") as Y.Array<any>) || new Y.Array();
    const replyViews: ReplyView[] = [];
    for (let i = 0; i < replies.length; i++) {
      const r = replies.get(i) as Y.Map<any>;
      const reactions: Record<string, number> = {};
      (r.get("reactions") as Y.Map<any>)?.forEach((v: number, k: string) => (reactions[k] = v));
      replyViews.push({
        id: r.get("id"),
        byUid: r.get("byUid"),
        byName: r.get("byName"),
        at: r.get("at"),
        text: r.get("text"),
        reactions,
      });
    }
    return {
      id,
      anchor: this.resolveAnchor(thread),
      quote: thread.get("quote") || "",
      resolved: !!thread.get("resolved"),
      authorUid: thread.get("authorUid") || "",
      authorName: thread.get("authorName") || "?",
      createdAt: thread.get("createdAt") || 0,
      replies: replyViews,
    };
  }

  /** Count of unresolved threads (for the file-explorer badge). */
  openCount(): number {
    let n = 0;
    this.map.forEach((t: Y.Map<any>) => { if (!t.get("resolved")) n++; });
    return n;
  }
}
