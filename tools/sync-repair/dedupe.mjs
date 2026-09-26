// Duplicate-content detection for notes hit by the 2026-09-25 re-seed bug.
// Produces DELETE RANGES against the original string only (never inserts), so
// applying them as Y.Text deletes removes exactly the duplicate copies.

const MIN_SECTION_BYTES = 200;

/** Smallest unit u such that s === u.repeat(k), k > 1; else null. */
export function periodicUnit(s) {
  const n = s.length;
  for (let k = 256; k > 1; k--) {
    if (n % k) continue;
    const u = s.slice(0, n / k);
    if (u.repeat(k) === s) return { unit: u, k };
  }
  return null;
}

/** Split at markdown heading lines; returns [{start, text}] covering s. */
export function sections(s) {
  const starts = [0];
  const re = /^#{1,6} /gm;
  let m;
  while ((m = re.exec(s))) if (m.index > 0) starts.push(m.index);
  return starts.map((start, i) => ({ start, text: s.slice(start, starts[i + 1] ?? s.length) }));
}

/** Blocks for the survival proof: blank-line separated, trimmed, non-empty. */
export function blocks(s) {
  return s.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
}

/** Merge + normalize ranges [{start, len}] (sorted, non-overlapping). */
function normalize(ranges) {
  const out = [];
  for (const r of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && r.start <= last.start + last.len) last.len = Math.max(last.len, r.start + r.len - last.start);
    else out.push({ ...r });
  }
  return out;
}

export function applyRanges(s, ranges) {
  let out = "", pos = 0;
  for (const r of ranges) { out += s.slice(pos, r.start); pos = r.start + r.len; }
  return out + s.slice(pos);
}

/**
 * Plan deletions. Iterates: (1) whole-string periodicity -> keep first unit;
 * (2) byte-identical repeated sections >= MIN_SECTION_BYTES -> keep first.
 * Ranges are always expressed against the ORIGINAL string.
 */
export function planDedupe(original) {
  // Track which original offsets survive so later passes can map back.
  let keep = [{ start: 0, len: original.length }]; // surviving spans of original
  const current = () => keep.map((k) => original.slice(k.start, k.start + k.len)).join("");
  const mapRange = (cStart, cLen) => { // current-string range -> original ranges
    const out = [];
    let off = 0;
    for (const k of keep) {
      const a = Math.max(cStart, off), b = Math.min(cStart + cLen, off + k.len);
      if (a < b) out.push({ start: k.start + (a - off), len: b - a });
      off += k.len;
    }
    return out;
  };
  const del = [];
  const methods = [];
  for (let iter = 0; iter < 20; iter++) {
    const s = current();
    let ranges = [];
    const p = periodicUnit(s);
    if (p) {
      ranges = [{ start: p.unit.length, len: s.length - p.unit.length }];
      methods.push(`periodic x${p.k}`);
    } else {
      const seen = new Set();
      for (const sec of sections(s)) {
        if (sec.text.length < MIN_SECTION_BYTES) continue;
        if (seen.has(sec.text)) ranges.push({ start: sec.start, len: sec.text.length });
        else seen.add(sec.text);
      }
      if (ranges.length) methods.push(`sections -${ranges.length}`);
    }
    if (!ranges.length) break;
    const orig = ranges.flatMap((r) => mapRange(r.start, r.len));
    del.push(...orig);
    const nd = normalize(del);
    keep = [];
    let pos = 0;
    for (const r of nd) { if (r.start > pos) keep.push({ start: pos, len: r.start - pos }); pos = r.start + r.len; }
    if (pos < original.length) keep.push({ start: pos, len: original.length - pos });
  }
  const ranges = normalize(del);
  return { ranges, result: applyRanges(original, ranges), methods };
}

/**
 * Proof (line level, stricter than blocks): every distinct line of `before`
 * survives in `after`; `after` has no line `before` lacked; the first
 * occurrences keep their order. The only line allowed to vanish is a copy
 * JUNCTION: a line that exists only where one duplicate copy ran into the next
 * without a newline ("...end of note## First heading"), i.e. it splits into two
 * lines that both survive. Blocks (blank-line paragraphs) are reported too.
 */
/** Split `x` entirely into strings from `dict` (fewest pieces), else null. */
function segment(x, dict) {
  const n = x.length, best = new Array(n + 1).fill(null);
  best[0] = [];
  for (let i = 0; i < n; i++) {
    if (!best[i]) continue;
    for (let j = i + 1; j <= n; j++) {
      const piece = x.slice(i, j);
      if (dict.has(piece) && (!best[j] || best[j].length > best[i].length + 1)) best[j] = [...best[i], piece];
    }
  }
  return best[n];
}

export function proveSurvival(before, after) {
  const bl = before.split("\n"), al = after.split("\n");
  const aSet = new Set(al), bSet = new Set(bl);
  const junctions = [], missing = [], junctionParts = new Set();
  for (const x of bSet) {
    if (aSet.has(x)) continue;
    const parts = segment(x, aSet);
    if (parts && parts.length > 1) { junctions.push(x); parts.forEach((p) => junctionParts.add(p)); }
    else missing.push(x);
  }
  // A line new to `after` is fine only as a piece of a vanished junction line.
  const extra = [...aSet].filter((x) => !bSet.has(x) && !junctionParts.has(x));
  const firstOrder = (arr, keepSet) => { const seen = new Set(), out = []; for (const x of arr) if (keepSet.has(x) && !seen.has(x)) { seen.add(x); out.push(x); } return out; };
  const common = new Set([...aSet].filter((x) => bSet.has(x)));
  const fb = firstOrder(bl, common), fa = firstOrder(al, common);
  // Order: first occurrences in `after` must be a subsequence-consistent
  // permutation of those in `before` (identical order of distinct lines).
  const orderOk = fb.length === fa.length && fb.every((x, i) => x === fa[i]);
  const bBlocks = new Set(blocks(before)), aText = after;
  const blocksMissing = [...bBlocks].filter((b) => !aText.includes(b.split("\n").filter(Boolean).at(-1) ?? b)).length;
  return {
    ok: missing.length === 0 && extra.length === 0 && orderOk,
    distinctLines: bSet.size, missing: missing.length, junctions: junctions.length, extra: extra.length, orderOk,
    distinctBlocks: bBlocks.size, blocksMissing,
    samples: { missing: missing.slice(0, 3).map((x) => x.slice(0, 120)), extra: extra.slice(0, 3).map((x) => x.slice(0, 120)) },
  };
}
