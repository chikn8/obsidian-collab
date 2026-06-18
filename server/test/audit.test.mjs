import fs from "fs/promises";
import os from "os";
import path from "path";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

console.log("server audit\n");

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-collab-audit-"));
process.env.PERSIST_DIR = tmp;
const { auditEvent, auditPathForTest } = await import("../src/audit.ts");

await auditEvent("share.create", {
  shareId: "share-1",
  role: "editor",
  token: "should-not-land",
  nested: { ownerKey: "also-secret", ok: true },
});

const raw = await fs.readFile(auditPathForTest(), "utf-8");
const rows = raw.trim().split("\n").map((line) => JSON.parse(line));
check("writes one audit row", rows.length === 1, `rows=${rows.length}`);
check("records event and share", rows[0].event === "share.create" && rows[0].shareId === "share-1");
check("redacts top-level token", rows[0].token === "[redacted]");
check("redacts nested owner key", rows[0].nested?.ownerKey === "[redacted]");

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
