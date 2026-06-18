import { safeSnapshotRelPath } from "../src/snapshots.ts";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

console.log("server snapshots\n");

check("accepts markdown snapshot path", safeSnapshotRelPath("notes/a.md") === "notes/a.md");
check("accepts canvas snapshot path", safeSnapshotRelPath("boards/plan.canvas") === "boards/plan.canvas");
check("rejects binary snapshot path", safeSnapshotRelPath("images/a.png") === null);
check("rejects traversal", safeSnapshotRelPath("../x.md") === null);
check("rejects normalized traversal", safeSnapshotRelPath("a/../../x.md") === null);
check("rejects windows separator", safeSnapshotRelPath("a\\b.md") === null);

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
