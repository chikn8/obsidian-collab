import fs from "fs/promises";
import os from "os";
import path from "path";
import { gunzipSync } from "zlib";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

console.log("server audit\n");

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-collab-audit-"));
process.env.PERSIST_DIR = tmp;
process.env.AUDIT_LOG_MAX_BYTES = "4096";
process.env.AUDIT_LOG_ROTATE_COUNT = "3";
process.env.AUDIT_LOG_TOTAL_MAX_BYTES = String(1024 * 1024);
// A manual archive next to the live log (the 2026-09-29 incident rename) must
// never be rotated, compressed, or pruned by the writer.
const manualArchive = path.join(tmp, "audit-20260929-0230.jsonl");
await fs.writeFile(manualArchive, "{\"event\":\"archived\"}\n");
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

console.log("\nrotation");
{
  // ~40 KB of rows against a 4 KB cap: must rotate ~10 times and keep 3 parts.
  for (let i = 0; i < 200; i++) {
    await auditEvent("ws.join", { room: `@share:file:${"n".repeat(120)}-${i}.md`, i });
  }
  const livePath = auditPathForTest();
  const base = path.basename(livePath);
  const partsDone = async () => {
    const names = await fs.readdir(tmp);
    return names.filter((n) => n.startsWith(`${base}.`) && n.endsWith(".gz"));
  };
  let parts = [];
  for (let i = 0; i < 100; i++) {
    const names = await fs.readdir(tmp);
    parts = await partsDone();
    const pending = names.filter((n) => n.startsWith(`${base}.`) && !n.endsWith(".gz"));
    if (parts.length > 0 && pending.length === 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const liveBytes = (await fs.stat(livePath)).size;
  check("live audit log stays under its size cap", liveBytes <= 4096, `bytes=${liveBytes}`);
  check("rotated parts are gzipped and capped at the rotate count", parts.length === 3, `parts=${JSON.stringify(parts)}`);
  check("rotated part names stay under the backup exclusion *.jsonl.*", parts.every((n) => /\.jsonl\..+/.test(n)));
  const newest = parts.sort().at(-1);
  const newestRows = newest
    ? gunzipSync(await fs.readFile(path.join(tmp, newest))).toString("utf-8").trim().split("\n").map((l) => JSON.parse(l))
    : [];
  check("rotated parts hold readable audit rows", newestRows.length > 0 && newestRows.every((r) => r.event === "ws.join"));
  const liveRows = (await fs.readFile(livePath, "utf-8")).trim().split("\n").map((l) => JSON.parse(l));
  check("newest row is in the live log", liveRows.at(-1)?.i === 199, `last=${JSON.stringify(liveRows.at(-1))}`);
  check("manual archive untouched", (await fs.readFile(manualArchive, "utf-8")) === "{\"event\":\"archived\"}\n");
}

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
