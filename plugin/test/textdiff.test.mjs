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

// ── Surrogate-pair safety: splice boundaries never split code points ──────────
console.log("Surrogate safety: boundaries land on code points in old AND new");
{
  const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
  const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;
  const splitsPair = (str, i) =>
    i > 0 && i < str.length && isHigh(str.charCodeAt(i - 1)) && isLow(str.charCodeAt(i));
  const boundariesOk = (oldStr, newStr, splices) => {
    let shift = 0;
    for (const { start, delCount, insert } of splices) {
      const newStart = start + shift;
      if (splitsPair(oldStr, start) || splitsPair(oldStr, start + delCount)) return false;
      if (splitsPair(newStr, newStart) || splitsPair(newStr, newStart + insert.length)) return false;
      if (insert.length && isLow(insert.charCodeAt(0))) return false;
      if (insert.length && isHigh(insert.charCodeAt(insert.length - 1))) return false;
      shift += insert.length - delCount;
    }
    return true;
  };
  const exact = (name, a, b) => {
    const single = diffRange(a, b);
    check(`${name}: diffRange reproduces`, applySplice(a, single) === b,
      JSON.stringify(single));
    check(`${name}: diffRange boundaries safe`, boundariesOk(a, b, [single]));
    const multi = diffRanges(a, b);
    check(`${name}: diffRanges reproduces`, applySplices(a, multi) === b,
      JSON.stringify(multi));
    check(`${name}: diffRanges boundaries safe`, boundariesOk(a, b, multi));
  };

  exact("emoji replace", "😀", "😁");
  exact("insert between emoji", "😀😀", "😀🎉😀");
  exact("delete one emoji from run", "😀😀😀", "😀😀");
  exact("CJK + emoji mix", "你好😀世界", "你好😁世界了");
  // Prefix collision: shared high surrogate, differing low half.
  exact("prefix collision", "a😀b", "a😁b");
  // Suffix collision: differing high surrogate, shared low half (U+1F600 vs U+1FA00).
  exact("suffix collision", "x😀", "x🨀");
  exact("suffix collision multi", "p😀q😀", "p🨀q🨀");
  // Astral char at both ends of the changed span.
  exact("astral both ends", "𝕏middle𝕏", "𝕐middle𝕐");

  // 😀 -> 😁 applied to a real Y.Text must not produce U+FFFD.
  {
    const doc = new Y.Doc();
    const text = doc.getText("codemirror");
    text.insert(0, "😀");
    const splices = diffRanges(text.toString(), "😁");
    doc.transact(() => {
      for (let i = splices.length - 1; i >= 0; i--) {
        const { start, delCount, insert } = splices[i];
        if (delCount > 0) text.delete(start, delCount);
        if (insert.length > 0) text.insert(start, insert);
      }
    });
    check("Y.Text emoji edit stays intact", text.toString() === "😁", JSON.stringify(text.toString()));
    check("Y.Text emoji edit has no U+FFFD", !text.toString().includes("�"));
  }

  // Forced Myers path (tiny maxCells) keeps code-point boundaries too.
  {
    const a = "a😀😀😀😀b";
    const b = "a😀🎉😀😀B";
    const splices = diffRanges(a, b, 1);
    check("Myers path reproduces", applySplices(a, splices) === b, JSON.stringify(splices));
    check("Myers path boundaries safe", boundariesOk(a, b, splices));
  }

  // Property loop: random emoji-heavy edit pairs stay exact and boundary-safe.
  let seed = 4242;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0xffffffff; };
  const alpha = ["😀", "😁", "🎉", "𝕏", "你", "界", "a", "b", "\n"];
  const randStr = (max) => {
    const n = Math.floor(rnd() * max);
    let s = "";
    for (let i = 0; i < n; i++) s += alpha[Math.floor(rnd() * alpha.length)];
    return s;
  };
  let ok = true;
  let worst = "";
  for (let i = 0; i < 400; i++) {
    const a = randStr(14);
    const b = randStr(14);
    const single = diffRange(a, b);
    const multi = diffRanges(a, b);
    if (applySplice(a, single) !== b || !boundariesOk(a, b, [single])) {
      ok = false; worst = `diffRange a=${JSON.stringify(a)} b=${JSON.stringify(b)}`; break;
    }
    if (applySplices(a, multi) !== b || !boundariesOk(a, b, multi)) {
      ok = false; worst = `diffRanges a=${JSON.stringify(a)} b=${JSON.stringify(b)}`; break;
    }
  }
  check("400 random emoji pairs stay exact and boundary-safe", ok, worst);
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
