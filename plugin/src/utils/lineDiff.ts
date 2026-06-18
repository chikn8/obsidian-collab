export type DiffKind = "context" | "add" | "remove" | "omitted";

export interface DiffRow {
  kind: DiffKind;
  text?: string;
  oldLine?: number;
  newLine?: number;
  count?: number;
}

export interface InlineDiff {
  rows: DiffRow[];
  added: number;
  removed: number;
  omitted: number;
  truncated: boolean;
}

export interface InlineDiffOptions {
  contextLines?: number;
  maxCells?: number;
  maxRows?: number;
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
}

function commonPrefix(a: string[], b: string[]): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

function commonSuffix(a: string[], b: string[], prefix: number): number {
  const max = Math.min(a.length, b.length) - prefix;
  let i = 0;
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

function appendContext(rows: DiffRow[], line: string, oldLine: number, newLine: number): void {
  rows.push({ kind: "context", text: line, oldLine, newLine });
}

function fallbackMiddle(oldLines: string[], newLines: string[], oldOffset: number, newOffset: number): DiffRow[] {
  const rows: DiffRow[] = [];
  for (let i = 0; i < oldLines.length; i++) {
    rows.push({ kind: "remove", text: oldLines[i], oldLine: oldOffset + i + 1 });
  }
  for (let i = 0; i < newLines.length; i++) {
    rows.push({ kind: "add", text: newLines[i], newLine: newOffset + i + 1 });
  }
  return rows;
}

function lcsMiddle(oldLines: string[], newLines: string[], oldOffset: number, newOffset: number, maxCells: number): DiffRow[] {
  const m = oldLines.length;
  const n = newLines.length;
  if (m === 0 || n === 0 || m * n > maxCells) return fallbackMiddle(oldLines, newLines, oldOffset, newOffset);

  const width = n + 1;
  const dirs = new Uint8Array((m + 1) * (n + 1));
  let prev = new Uint16Array(width);
  let curr = new Uint16Array(width);

  for (let i = 1; i <= m; i++) {
    curr.fill(0);
    for (let j = 1; j <= n; j++) {
      const idx = i * width + j;
      if (oldLines[i - 1] === newLines[j - 1]) {
        curr[j] = prev[j - 1] + 1;
        dirs[idx] = 3; // diagonal/context
      } else if (prev[j] >= curr[j - 1]) {
        curr[j] = prev[j];
        dirs[idx] = 1; // remove
      } else {
        curr[j] = curr[j - 1];
        dirs[idx] = 2; // add
      }
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }

  const reversed: DiffRow[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    const dir = i > 0 && j > 0 ? dirs[i * width + j] : (i > 0 ? 1 : 2);
    if (dir === 3) {
      reversed.push({
        kind: "context",
        text: oldLines[i - 1],
        oldLine: oldOffset + i,
        newLine: newOffset + j,
      });
      i--;
      j--;
    } else if (dir === 1) {
      reversed.push({ kind: "remove", text: oldLines[i - 1], oldLine: oldOffset + i });
      i--;
    } else {
      reversed.push({ kind: "add", text: newLines[j - 1], newLine: newOffset + j });
      j--;
    }
  }

  return reversed.reverse();
}

function rawLineDiff(oldText: string, newText: string, maxCells: number): DiffRow[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const prefix = commonPrefix(oldLines, newLines);
  const suffix = commonSuffix(oldLines, newLines, prefix);
  const rows: DiffRow[] = [];

  for (let i = 0; i < prefix; i++) appendContext(rows, oldLines[i], i + 1, i + 1);

  const oldMid = oldLines.slice(prefix, oldLines.length - suffix);
  const newMid = newLines.slice(prefix, newLines.length - suffix);
  rows.push(...lcsMiddle(oldMid, newMid, prefix, prefix, maxCells));

  for (let i = 0; i < suffix; i++) {
    const oldIndex = oldLines.length - suffix + i;
    const newIndex = newLines.length - suffix + i;
    appendContext(rows, oldLines[oldIndex], oldIndex + 1, newIndex + 1);
  }

  return rows;
}

function compactRows(rows: DiffRow[], contextLines: number): { rows: DiffRow[]; omitted: number } {
  if (!rows.some((row) => row.kind === "add" || row.kind === "remove")) return { rows, omitted: 0 };

  const keep = new Uint8Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind !== "add" && rows[i].kind !== "remove") continue;
    const start = Math.max(0, i - contextLines);
    const end = Math.min(rows.length - 1, i + contextLines);
    for (let j = start; j <= end; j++) keep[j] = 1;
  }

  const out: DiffRow[] = [];
  let omitted = 0;
  for (let i = 0; i < rows.length;) {
    if (keep[i]) {
      out.push(rows[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && !keep[j]) j++;
    const count = j - i;
    omitted += count;
    out.push({ kind: "omitted", count });
    i = j;
  }
  return { rows: out, omitted };
}

export function buildInlineDiff(oldText: string, newText: string, options: InlineDiffOptions = {}): InlineDiff {
  const contextLines = Math.max(0, options.contextLines ?? 3);
  const maxCells = Math.max(1, options.maxCells ?? 250_000);
  const maxRows = Math.max(1, options.maxRows ?? 900);
  const raw = rawLineDiff(oldText, newText, maxCells);
  const added = raw.filter((row) => row.kind === "add").length;
  const removed = raw.filter((row) => row.kind === "remove").length;
  const compact = compactRows(raw, contextLines);
  const truncated = compact.rows.length > maxRows;
  const rows = truncated
    ? [...compact.rows.slice(0, maxRows), { kind: "omitted" as const, count: compact.rows.length - maxRows }]
    : compact.rows;
  const omitted = compact.omitted + (truncated ? compact.rows.length - maxRows : 0);
  return { rows, added, removed, omitted, truncated };
}
