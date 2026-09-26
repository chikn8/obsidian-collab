/**
 * Regression for the 1.7 GB diagnostics folder (2026-09-25): a reconnect storm
 * with diagnostic logging on must not grow the folder past ~20 MB, must
 * rate-limit a single flooding event, and must leave non-trace files alone.
 */
// Run flush timers as soon as the current batch finishes (no real 1 s waits).
globalThis.setTimeout = (fn) => { setImmediate(fn); return 0; };
let fakeNow = 1_800_000_000_000;
Date.now = () => fakeNow;

const { configureDiagnostics, trace, getRecentDiagnostics } = await import("../src/utils/log.ts");

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}
console.log("diagnostics cap\n");

const dir = ".obsidian/plugins/live-collab/diagnostics";
const files = new Map();
const mtimes = new Map();
const MB = 1024 * 1024;
// A folder that already overflowed, like Elijah's: 6 × 5 MB of old traces.
for (let i = 0; i < 6; i++) {
  files.set(`${dir}/trace-old${i}.jsonl`, "x".repeat(5 * MB));
  mtimes.set(`${dir}/trace-old${i}.jsonl`, fakeNow - (10 - i) * 86_400_000);
}
const bundle = `${dir}/diagnostic-bundle-2026-09-01.json`;
files.set(bundle, "{}".padEnd(MB, " "));
mtimes.set(bundle, fakeNow - 30 * 86_400_000);

const adapter = {
  async mkdir() {},
  async write(p, body) { files.set(p, body); mtimes.set(p, fakeNow); },
  async append(p, body) { files.set(p, (files.get(p) ?? "") + body); mtimes.set(p, fakeNow); },
  async list(d) { return { files: [...files.keys()].filter((p) => p.startsWith(d + "/")), folders: [] }; },
  async stat(p) { return files.has(p) ? { size: files.get(p).length, mtime: mtimes.get(p), ctime: 0, type: "file" } : null; },
  async remove(p) { files.delete(p); mtimes.delete(p); },
};
configureDiagnostics({ app: { vault: { configDir: ".obsidian", adapter } }, debugLogging: true, diagnosticLogging: true });

const drain = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const path = "4_Projects/Synced Obsidian/Viewd/_AI/some fairly long folder name/another level/README.md";
// 120 simulated seconds of a storm: 5,000 file-status rows/s (the incident
// rate) plus a spread of distinct events that do not hit the rate limit.
const SECS = Number(process.env.CAP_SECS || 120);
for (let sec = 0; sec < SECS; sec++) {
  fakeNow += 1000;
  for (let i = 0; i < 5000; i++) trace("ws", "file-status", { path, room: `@share:file:${i}`, status: i % 2 ? "connecting" : "disconnected" });
  for (let k = 0; k < 40; k++) {
    for (let i = 0; i < 40; i++) trace("storm", `distinct-${k}`, { path, i, pad: "y".repeat(400) });
  }
  await drain();
}
fakeNow += 2000;
trace("ws", "after-storm", {});
await drain();

const traceFiles = [...files.keys()].filter((p) => /\/trace-[^/]*\.jsonl$/.test(p));
const traceBytes = traceFiles.reduce((n, p) => n + files.get(p).length, 0);
const persisted = traceFiles.flatMap((p) => files.get(p).split("\n").filter(Boolean));
const fileStatusRows = persisted.filter((l) => l.includes('"event":"file-status"')).length;
const summaries = getRecentDiagnostics().filter((r) => r.event === "rate-limited");

check("trace folder stays within 20 MB", traceBytes <= 20 * MB, `${(traceBytes / MB).toFixed(1)} MB in ${traceFiles.length} files`);
check("oldest pre-existing traces were pruned first", !files.has(`${dir}/trace-old0.jsonl`));
check("non-trace files are never pruned", files.has(bundle));
check("current session trace rotates into parts", traceFiles.some((p) => /trace-[0-9a-f]{8}-\d+\.jsonl$/.test(p)), JSON.stringify(traceFiles));
check("a flooding event is rate limited", fileStatusRows <= 50 * (SECS + 1), `file-status rows persisted: ${fileStatusRows}`);
check("suppressed rows are summarised, not silently dropped",
  summaries.some((r) => r.fields?.event === "debug:ws:file-status" && r.fields?.suppressed > 0));

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
console.log("ALL PASSED");
process.exit(0);
