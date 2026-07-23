interface UnboundEditorContent {
  content: string;
  at: number;
}

const UNBOUND_EDITOR_CONTENT_TTL_MS = 10 * 60_000;
const MAX_UNBOUND_EDITOR_CONTENT = 8;
const unboundEditorContent = new Map<string, UnboundEditorContent>();

function pruneUnboundEditorContent(now: number): void {
  for (const [path, entry] of unboundEditorContent) {
    if (now - entry.at > UNBOUND_EDITOR_CONTENT_TTL_MS) unboundEditorContent.delete(path);
  }
  while (unboundEditorContent.size > MAX_UNBOUND_EDITOR_CONTENT) {
    const oldestPath = unboundEditorContent.keys().next().value;
    if (oldestPath == null) return;
    unboundEditorContent.delete(oldestPath);
  }
}

/** Remember the synced Y.Text content that this editor displayed when unbound. */
export function stashUnboundEditorContent(path: string, content: string, at = Date.now()): void {
  pruneUnboundEditorContent(at);
  // Refresh insertion order when this path is unbound again.
  unboundEditorContent.delete(path);
  unboundEditorContent.set(path, { content, at });
  pruneUnboundEditorContent(at);
}

/** True when the buffer is still exactly the synced content present at unbind. */
export function matchesUnboundEditorContent(path: string, content: string, now = Date.now()): boolean {
  const entry = unboundEditorContent.get(path);
  return !!entry && now - entry.at <= UNBOUND_EDITOR_CONTENT_TTL_MS && entry.content === content;
}

/** Clear the old-buffer proof once its editor has successfully rebound. */
export function clearUnboundEditorContent(path: string): void {
  unboundEditorContent.delete(path);
}
