import { log } from "../utils/log";

/**
 * Deterministic feedback-loop guard.
 *
 * The plugin writes to the vault (remote change → disk) and ALSO listens to
 * vault events (disk change → ytext). Every plugin-initiated write therefore
 * produces an "echo" vault event that must NOT be fed back into Yjs, or the
 * system oscillates ("feedback loops I've had so much").
 *
 * The OLD design used `setTimeout` windows (`writingPaths` 500ms/2s) to ignore
 * echoes. On mobile / slow disk / batched FS events the echo can arrive AFTER
 * the window expires → the guard misses → spurious re-apply → churn/oscillation.
 *
 * This guard is **content-based, not time-based**: before any plugin write we
 * record a fingerprint of exactly what we wrote; an incoming vault event whose
 * content matches a recent fingerprint is provably our own echo and is dropped,
 * no matter how late it arrives. Timing never affects correctness.
 *
 * A small ring of recent fingerprints per path (not just the latest) defends
 * against the "stale echo" race: if we write V2 then quickly write V3 (remote
 * op merged in between), BOTH echoes (V2 and V3) must be recognised — otherwise
 * the late V2 echo would diff against the newer V3 ytext and clobber the merge.
 *
 * Create/delete echoes use distinct SENTINELS (not content fingerprints) and are
 * consumed on match — a create/delete fires exactly once, and keeping them in a
 * separate namespace means an empty-file create echo can never be confused with
 * a genuine empty-content write (fingerprint("") is a real value).
 *
 * A large TTL bounds memory only; it is never the primary guard.
 */

// Sentinels live in the same per-path ring as content fingerprints but can never
// equal one: a fingerprint is always "<len>:<hex>", these are not.
const CREATED = "~created~";
const TOMBSTONE = "~deleted~";

/** Fast synchronous content fingerprint: length + FNV-1a/32. */
export function fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${s.length}:${(h >>> 0).toString(16)}`;
}

// ── Re-entrancy depth (module-global) ─────────────────────────────────────────
// Set while the plugin is synchronously applying a remote change to disk. Vault
// events delivered *synchronously* within that window are our own and skipped.
// Best-effort defence-in-depth; the content fingerprint is the real guard (vault
// events usually arrive async, after this depth has already unwound).
let _remoteApplyDepth = 0;
export function beginRemoteApply(): void {
  _remoteApplyDepth++;
}
export function endRemoteApply(): void {
  _remoteApplyDepth = Math.max(0, _remoteApplyDepth - 1);
}
export function isApplyingRemote(): boolean {
  return _remoteApplyDepth > 0;
}

interface Mark {
  fp: string;
  ts: number;
}

export class EchoGuard {
  private marks = new Map<string, Mark[]>();
  private readonly ttl: number;
  private readonly maxPerPath: number;

  constructor(ttlMs = 30_000, maxPerPath = 24) {
    this.ttl = ttlMs;
    this.maxPerPath = maxPerPath;
  }

  /** Record that the plugin is about to write `content` to `path`. */
  mark(path: string, content: string): void {
    this.push(path, fingerprint(content));
  }

  /** Record that the plugin is about to create `path` (empty file). */
  markCreated(path: string): void {
    this.push(path, CREATED);
  }

  /** Record that the plugin is about to delete `path`. */
  markDeleted(path: string): void {
    this.push(path, TOMBSTONE);
  }

  /**
   * True when an incoming vault modify for `path` carrying `content` matches a
   * recent plugin write — i.e. it is our own echo. Does NOT clear the mark (so
   * duplicate FS events for the same write are all absorbed; TTL reaps).
   */
  isEcho(path: string, content: string): boolean {
    return this.matches(path, fingerprint(content), false);
  }

  /** True when an incoming create for `path` is a plugin-initiated create. Consumes. */
  isCreatedEcho(path: string): boolean {
    return this.matches(path, CREATED, true);
  }

  /** True when an incoming delete for `path` matches a plugin-initiated delete. Consumes. */
  isDeletedEcho(path: string): boolean {
    return this.matches(path, TOMBSTONE, true);
  }

  /** Drop all marks for a path (e.g. when a file is permanently removed). */
  clear(path: string): void {
    this.marks.delete(path);
  }

  private push(path: string, fp: string): void {
    const now = Date.now();
    const list = (this.marks.get(path) || []).filter((m) => now - m.ts <= this.ttl);
    list.push({ fp, ts: now });
    while (list.length > this.maxPerPath) list.shift();
    this.marks.set(path, list);
    // Opportunistic global sweep so abandoned paths don't accumulate forever.
    if (this.marks.size > 256) this.sweep(now);
  }

  /** Match `fp` against this path's recent marks. If `consume`, remove the first
   *  matching mark (single-shot for create/delete echoes). */
  private matches(path: string, fp: string, consume: boolean): boolean {
    const list = this.marks.get(path);
    if (!list || list.length === 0) return false;
    const now = Date.now();
    let hit = false;
    const kept: Mark[] = [];
    for (const m of list) {
      if (now - m.ts > this.ttl) continue; // expired
      if (m.fp === fp && !(consume && hit)) {
        hit = true;
        if (consume) continue; // drop this matching mark
      }
      kept.push(m);
    }
    if (kept.length) this.marks.set(path, kept);
    else this.marks.delete(path);
    if (hit) log("loop", "echo dropped", path);
    return hit;
  }

  private sweep(now: number): void {
    for (const [path, list] of this.marks) {
      const kept = list.filter((m) => now - m.ts <= this.ttl);
      if (kept.length) this.marks.set(path, kept);
      else this.marks.delete(path);
    }
  }
}
