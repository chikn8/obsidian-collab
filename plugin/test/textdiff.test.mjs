/**
 * Phase D regression: the reconciliation diff is correctness-critical (it turns
 * offline disk edits into Yjs ops). Property-test that diffRange applied to
 * `old` always reproduces `new` exactly, and that an offline disk edit captured
 * against the IDB base merges with a concurrent remote edit without loss.
 *
 * Run: node test/textdiff.test.mjs
 */
import * as Y from "yjs";
import { diffRange, diffRanges } from "../src/utils/textDiff.ts";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

function applySplice(oldStr, { start, delCount, insert }) {
  return oldStr.slice(0, start) + insert + oldStr.slice(start + delCount);
}

function applySplices(oldStr, splices) {
  let out = oldStr;
  for (let i = splices.length - 1; i >= 0; i--) out = applySplice(out, splices[i]);
  return out;
}

// ── 1. diffRange is exact for random inputs (no corruption) ───────────────────
console.log("diffRange property: apply(old, diff(old,new)) === new");
{
  let seed = 99;
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const alpha = "abcde\n ";
  const randStr = (max) => {
    const n = Math.floor(rnd() * max);
    let s = "";
    for (let i = 0; i < n; i++) s += alpha[Math.floor(rnd() * alpha.length)];
    return s;
  };
  let ok = true;
  let worst = "";
  for (let i = 0; i < 5000; i++) {
    const a = randStr(40);
    const b = randStr(40);
    const got = applySplice(a, diffRange(a, b));
    if (got !== b) { ok = false; worst = `a=${JSON.stringify(a)} b=${JSON.stringify(b)} got=${JSON.stringify(got)}`; break; }
  }
  check("5000 random pairs reproduce exactly", ok, worst);

  // identical strings → no-op splice
  const d = diffRange("same", "same");
  check("identical → no-op", d.delCount === 0 && d.insert === "");
  // empty edge cases
  check("'' → 'x' inserts", applySplice("", diffRange("", "x")) === "x");
	  check("'x' → '' deletes", applySplice("x", diffRange("x", "")) === "");
}

console.log("diffRanges property: separated edits stay separated");
{
  let seed = 123;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0xffffffff; };
  const alpha = "abcdef\n ";
  const randStr = (max) => {
    const n = Math.floor(rnd() * max);
    let s = "";
    for (let i = 0; i < n; i++) s += alpha[Math.floor(rnd() * alpha.length)];
    return s;
  };
  let ok = true;
  let worst = "";
  for (let i = 0; i < 3000; i++) {
    const a = randStr(35);
    const b = randStr(35);
    const got = applySplices(a, diffRanges(a, b));
    if (got !== b) { ok = false; worst = `a=${JSON.stringify(a)} b=${JSON.stringify(b)} got=${JSON.stringify(got)}`; break; }
  }
  check("3000 random pairs reproduce exactly", ok, worst);
  const splices = diffRanges("aa\nmiddle\nzz", "AA\nmiddle\nZZ");
  check("two distant edits produce multiple splices", splices.length >= 2, JSON.stringify(splices));
  const largeOld = `${"x".repeat(25_000)}\nmiddle\n${"y".repeat(25_000)}`;
  const largeNew = `START\n${largeOld}\nEND`;
  const largeSplices = diffRanges(largeOld, largeNew);
  check("large distant edits reproduce exactly", applySplices(largeOld, largeSplices) === largeNew);
  check("large distant edits stay separate", largeSplices.length >= 2, JSON.stringify(largeSplices));
}

// ── 2. Offline reconcile against IDB base merges with concurrent remote edit ───
console.log("Offline reconcile (base-aware) merges with concurrent remote edit");
{
  const ancestor = "line one\nline two\nline three\n";

  // Server/base doc seeded with the ancestor.
  const base = new Y.Doc();
  base.getText("codemirror").insert(0, ancestor);
  const baseState = Y.encodeStateAsUpdate(base);

  // Client A was offline; its IDB base is `ancestor`; on disk the user changed
  // the LAST line. A captures that as a diff against the IDB base (LAYER 3).
  const A = new Y.Doc();
  Y.applyUpdate(A, baseState);
  const aText = A.getText("codemirror");
  const diskA = "line one\nline two\nline three EDITED\n";
  const { start, delCount, insert } = diffRange(aText.toString(), diskA);
  A.transact(() => {
    if (delCount > 0) aText.delete(start, delCount);
    if (insert.length > 0) aText.insert(start, insert);
  }, "local-disk");

  // Client B (online) edited the FIRST line concurrently.
  const B = new Y.Doc();
  Y.applyUpdate(B, baseState);
  const bText = B.getText("codemirror");
  B.transact(() => { bText.insert(0, "FIRST "); }, "user");

  // Sync both ways.
  Y.applyUpdate(A, Y.encodeStateAsUpdate(B));
  Y.applyUpdate(B, Y.encodeStateAsUpdate(A));

  const merged = A.getText("codemirror").toString();
  check("converges", merged === B.getText("codemirror").toString());
  check("A's offline edit survives", merged.includes("line three EDITED"), `merged=${JSON.stringify(merged)}`);
  check("B's concurrent remote edit survives", merged.includes("FIRST "), `merged=${JSON.stringify(merged)}`);
}

console.log("Offline reconcile with separated local edits preserves middle remote edit");
{
  const ancestor = "top\nmiddle\nbottom\n";
  const base = new Y.Doc();
  base.getText("codemirror").insert(0, ancestor);
  const baseState = Y.encodeStateAsUpdate(base);

  const A = new Y.Doc();
  Y.applyUpdate(A, baseState);
  const aText = A.getText("codemirror");
  const diskA = "TOP\nmiddle\nBOTTOM\n";
  const splices = diffRanges(aText.toString(), diskA);
  A.transact(() => {
    for (let i = splices.length - 1; i >= 0; i--) {
      const { start, delCount, insert } = splices[i];
      if (delCount > 0) aText.delete(start, delCount);
      if (insert.length > 0) aText.insert(start, insert);
    }
  }, "local-disk");

  const B = new Y.Doc();
  Y.applyUpdate(B, baseState);
  const bText = B.getText("codemirror");
  const mid = bText.toString().indexOf("middle") + "middle".length;
  B.transact(() => { bText.insert(mid, " REMOTE"); }, "user");

  Y.applyUpdate(A, Y.encodeStateAsUpdate(B));
  Y.applyUpdate(B, Y.encodeStateAsUpdate(A));

  const merged = A.getText("codemirror").toString();
  check("converges after separated edits", merged === B.getText("codemirror").toString());
  check("first local edit survives", merged.includes("TOP"), `merged=${JSON.stringify(merged)}`);
  check("second local edit survives", merged.includes("BOTTOM"), `merged=${JSON.stringify(merged)}`);
  check("middle remote edit survives", merged.includes("middle REMOTE"), `merged=${JSON.stringify(merged)}`);
}

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
