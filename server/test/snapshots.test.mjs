import fs from "fs/promises";
import os from "os";
import path from "path";
import * as Y from "yjs";

process.env.PERSIST_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "snapshots-test-"));
const { safeSnapshotRelPath, writeSnapshot } = await import("../src/snapshots.ts");

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

{
  const doc = new Y.Doc();
  await writeSnapshot("@share:file:empty.md", doc);
  const snapshotPath = path.join(process.env.PERSIST_DIR, "snapshots", "share", "empty.md");
  const content = await fs.readFile(snapshotPath, "utf-8");
  check("writes empty-note snapshots", content === "", JSON.stringify(content));
  doc.destroy();
}

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
