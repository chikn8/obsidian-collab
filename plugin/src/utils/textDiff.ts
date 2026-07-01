/**
 * Minimal single-range diff between two strings: trim the common prefix and
 * suffix, leaving one replaced middle span. Shared by FileProvider's
 * disk→ytext reconciliation paths so the diff math lives in exactly one place
 * (and can be unit-tested headlessly without Obsidian/Yjs/network deps).
 *
 * Returns the splice to apply: delete `delCount` chars at `start`, then insert
 * `insert`. A no-op diff (identical strings) yields delCount=0, insert="".
 */
export interface TextSplice {
  start: number;
  delCount: number;
  insert: string;
}

type DiffOp = ["equal" | "remove" | "add", string];

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * True when a splice boundary at `index` would land between the halves of a
 * surrogate pair in `str`. Yjs stores UTF-16 but encodes updates as UTF-8, so
 * a boundary inside a pair permanently corrupts the text on peers (U+FFFD).
 */
function splitsSurrogatePair(str: string, index: number): boolean {
  if (index <= 0 || index >= str.length) return false;
  return isHighSurrogate(str.charCodeAt(index - 1)) && isLowSurrogate(str.charCodeAt(index));
}

export function diffRange(oldStr: string, newStr: string): TextSplice {
  let start = 0;
  const maxStart = Math.min(oldStr.length, newStr.length);
  while (start < maxStart && oldStr[start] === newStr[start]) start++;
  // Back off a prefix that ends between the halves of a surrogate pair.
  if (splitsSurrogatePair(oldStr, start) || splitsSurrogatePair(newStr, start)) start--;

  let endOld = oldStr.length;
  let endNew = newStr.length;
  while (endOld > start && endNew > start && oldStr[endOld - 1] === newStr[endNew - 1]) {
    endOld--;
    endNew--;
  }
  // Same guard for the suffix: shrink it so both boundaries stay on code points.
  if (splitsSurrogatePair(oldStr, endOld) || splitsSurrogatePair(newStr, endNew)) {
    endOld++;
    endNew++;
  }

  return { start, delCount: endOld - start, insert: newStr.substring(start, endNew) };
}

function opsToSplices(ops: DiffOp[], startOffset: number): TextSplice[] {
  const splices: TextSplice[] = [];
  let oldIndex = startOffset;
  let runStart: number | null = null;
  let delCount = 0;
  let insert = "";
  const flush = () => {
    if (runStart == null) return;
    splices.push({ start: runStart, delCount, insert });
    runStart = null;
    delCount = 0;
    insert = "";
  };

  for (const [kind, ch] of ops) {
    // Ops carry whole code points, so `ch` may be 1 or 2 UTF-16 units long.
    if (kind === "equal") {
      flush();
      oldIndex += ch.length;
    } else if (kind === "remove") {
      if (runStart == null) runStart = oldIndex;
      delCount += ch.length;
      oldIndex += ch.length;
    } else {
      if (runStart == null) runStart = oldIndex;
      insert += ch;
    }
  }
  flush();
  return splices;
}

function myersDiffOps(oldMid: string[], newMid: string[], maxEdits: number): DiffOp[] | null {
  const m = oldMid.length;
  const n = newMid.length;
  const max = m + n;
  const limit = Math.min(max, maxEdits);
  let frontier = new Map<number, number>([[1, 0]]);
  const trace: Array<Map<number, number>> = [];

  for (let d = 0; d <= limit; d++) {
    const next = new Map<number, number>();
    for (let k = -d; k <= d; k += 2) {
      const down = frontier.get(k + 1) ?? -1;
      const right = frontier.get(k - 1) ?? -1;
      let x = k === -d || (k !== d && right < down) ? down : right + 1;
      if (x < 0) x = 0;
      let y = x - k;
      while (x < m && y < n && oldMid[x] === newMid[y]) {
        x++;
        y++;
      }
      next.set(k, x);
      if (x >= m && y >= n) {
        trace.push(next);
        return backtrackMyers(oldMid, newMid, trace);
      }
    }
    trace.push(next);
    frontier = next;
  }
  return null;
}

function backtrackMyers(oldMid: string[], newMid: string[], trace: Array<Map<number, number>>): DiffOp[] {
  const ops: DiffOp[] = [];
  let x = oldMid.length;
  let y = newMid.length;

  for (let d = trace.length - 1; d > 0; d--) {
    const k = x - y;
    const prev = trace[d - 1];
    const down = prev.get(k + 1) ?? -1;
    const right = prev.get(k - 1) ?? -1;
    const prevK = k === -d || (k !== d && right < down) ? k + 1 : k - 1;
    const prevX = prev.get(prevK) ?? 0;
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      ops.push(["equal", oldMid[x - 1]]);
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push(["add", newMid[y - 1]]);
      y--;
    } else {
      ops.push(["remove", oldMid[x - 1]]);
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push(["equal", oldMid[x - 1]]);
    x--;
    y--;
  }
  ops.reverse();
  return ops;
}

export function diffRanges(oldStr: string, newStr: string, maxCells = 250_000): TextSplice[] {
  if (oldStr === newStr) return [];

  let prefix = 0;
  const maxPrefix = Math.min(oldStr.length, newStr.length);
  while (prefix < maxPrefix && oldStr[prefix] === newStr[prefix]) prefix++;
  // Back off a prefix that ends between the halves of a surrogate pair.
  if (splitsSurrogatePair(oldStr, prefix) || splitsSurrogatePair(newStr, prefix)) prefix--;

  let suffix = 0;
  const maxSuffix = Math.min(oldStr.length, newStr.length) - prefix;
  while (
    suffix < maxSuffix &&
    oldStr[oldStr.length - 1 - suffix] === newStr[newStr.length - 1 - suffix]
  ) {
    suffix++;
  }
  // Same guard for the suffix boundary in either string.
  if (
    splitsSurrogatePair(oldStr, oldStr.length - suffix) ||
    splitsSurrogatePair(newStr, newStr.length - suffix)
  ) {
    suffix--;
  }

  // Diff the middles by code point (not UTF-16 unit) so no splice boundary
  // produced by the LCS/Myers paths can land inside a surrogate pair.
  const oldMid = Array.from(oldStr.slice(prefix, oldStr.length - suffix));
  const newMid = Array.from(newStr.slice(prefix, newStr.length - suffix));
  const m = oldMid.length;
  const n = newMid.length;
  if (m === 0 || n === 0) return [diffRange(oldStr, newStr)];
  if (m * n > maxCells) {
    const maxEdits = m + n > 200_000 ? 256 : 1024;
    const myersOps = myersDiffOps(oldMid, newMid, maxEdits);
    if (myersOps) {
      const splices = opsToSplices(myersOps, prefix);
      if (splices.length) return splices;
    }
    return [diffRange(oldStr, newStr)];
  }

  const width = n + 1;
  const dirs = new Uint8Array((m + 1) * (n + 1));
  let prev = new Uint16Array(width);
  let curr = new Uint16Array(width);

  for (let i = 1; i <= m; i++) {
    curr.fill(0);
    for (let j = 1; j <= n; j++) {
      const idx = i * width + j;
      if (oldMid[i - 1] === newMid[j - 1]) {
        curr[j] = prev[j - 1] + 1;
        dirs[idx] = 3;
      } else if (prev[j] >= curr[j - 1]) {
        curr[j] = prev[j];
        dirs[idx] = 1;
      } else {
        curr[j] = curr[j - 1];
        dirs[idx] = 2;
      }
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }

  const ops: DiffOp[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    const dir = i > 0 && j > 0 ? dirs[i * width + j] : (i > 0 ? 1 : 2);
    if (dir === 3) {
      ops.push(["equal", oldMid[i - 1]]);
      i--;
      j--;
    } else if (dir === 1) {
      ops.push(["remove", oldMid[i - 1]]);
      i--;
    } else {
      ops.push(["add", newMid[j - 1]]);
      j--;
    }
  }
  ops.reverse();

  const splices = opsToSplices(ops, prefix);
  return splices.length ? splices : [diffRange(oldStr, newStr)];
}
