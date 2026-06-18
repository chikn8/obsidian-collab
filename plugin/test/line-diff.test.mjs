import { buildInlineDiff } from "../src/utils/lineDiff.ts";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

console.log("line diff\n");

{
  const diff = buildInlineDiff("a\nb\nc\n", "a\nB\nc\nd\n", { contextLines: 1 });
  check("counts added lines", diff.added === 2, `added=${diff.added}`);
  check("counts removed lines", diff.removed === 1, `removed=${diff.removed}`);
  check("keeps context near changes", diff.rows.some((row) => row.kind === "context" && row.text === "a"));
  check("shows new trailing line", diff.rows.some((row) => row.kind === "add" && row.text === "d"));
}

{
  const oldText = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  const newLines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
  newLines[10] = "line ten changed";
  const diff = buildInlineDiff(oldText, newLines.join("\n"), { contextLines: 2 });
  check("omits distant unchanged lines", diff.rows.some((row) => row.kind === "omitted"));
  check("keeps changed line", diff.rows.some((row) => row.kind === "add" && row.text === "line ten changed"));
}

{
  const diff = buildInlineDiff("same\ntext", "same\ntext");
  check("identical diff has no changes", diff.added === 0 && diff.removed === 0);
  check("identical diff keeps rows for preview", diff.rows.length === 2);
}

{
  const oldText = Array.from({ length: 30 }, (_, i) => `old ${i}`).join("\n");
  const newText = Array.from({ length: 30 }, (_, i) => `new ${i}`).join("\n");
  const diff = buildInlineDiff(oldText, newText, { maxRows: 10 });
  check("large rendered diff truncates", diff.truncated);
  check("truncation adds omitted row", diff.rows[diff.rows.length - 1].kind === "omitted");
}

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
