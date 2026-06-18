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

export function diffRange(oldStr: string, newStr: string): TextSplice {
  let start = 0;
  const maxStart = Math.min(oldStr.length, newStr.length);
  while (start < maxStart && oldStr[start] === newStr[start]) start++;

  let endOld = oldStr.length;
  let endNew = newStr.length;
  while (endOld > start && endNew > start && oldStr[endOld - 1] === newStr[endNew - 1]) {
    endOld--;
    endNew--;
  }

  return { start, delCount: endOld - start, insert: newStr.substring(start, endNew) };
}
