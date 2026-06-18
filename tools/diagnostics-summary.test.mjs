#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-collab-diag-"));
const fixture = path.join(dir, "bundle.json");

const bundle = {
  context: {
    plugin: { id: "live-collab", version: "test" },
    platform: { mobile: true, ios: true },
    settings: { shareCount: 1, legacyShareCount: 0, roles: { editor: 1 }, ntfyConfigured: false, customCursorColor: true },
    runtime: {
      managerCount: 1,
      boundPath: "Shared/note.md",
      boundProviderReady: true,
      boundHasPresence: true,
      managers: [{
        shareId: "share-1",
        status: "connected",
        role: "editor",
        fileProviders: 2,
        pendingOffline: 1,
        renderedFilePresenceHosts: 1,
        renderedTabPresenceHosts: 0,
        lastPresenceHadMissingAnchors: true,
      }],
    },
    diagnostics: {
      traceActive: true,
      rowCount: 5,
      maxRows: 10000,
      traceLineCount: 5,
      maxTraceLines: 50000,
      droppedRows: 0,
      droppedTraceLines: 0,
      nextSeq: 6,
      tracePath: "trace.jsonl",
    },
  },
  rows: [
    { seq: 1, ts: "2026-06-18T00:00:00.000Z", dt: 1, level: "debug", ns: "presence", event: "file-anchor-missing", fields: { path: "Shared/note.md" } },
    { seq: 2, ts: "2026-06-18T00:00:00.100Z", dt: 101, level: "debug", ns: "bind", event: "lifecycle-flush-start", fields: { path: "Shared/note.md", reason: "pagehide" } },
    { seq: 3, ts: "2026-06-18T00:00:00.200Z", dt: 201, level: "debug", ns: "bind", event: "lifecycle-flush-done", fields: { path: "Shared/note.md", reason: "pagehide" } },
    { seq: 4, ts: "2026-06-18T00:00:00.300Z", dt: 301, level: "debug", ns: "file", event: "write-ok", fields: { path: "Shared/note.md", reason: "lifecycle-pagehide", len: 12 } },
    { seq: 5, ts: "2026-06-18T00:00:00.400Z", dt: 401, level: "error", ns: "share", event: "error", fields: { error: "boom" } },
  ],
};

fs.writeFileSync(fixture, JSON.stringify(bundle, null, 2));

const result = spawnSync(process.execPath, ["tools/diagnostics-summary.mjs", fixture], {
  cwd: root,
  encoding: "utf8",
});

if (result.status !== 0) {
  console.error(result.stdout);
  console.error(result.stderr);
  process.exit(result.status || 1);
}

const out = result.stdout;
check(out.includes("Active Editor / Lifecycle Signals"), "prints lifecycle section");
check(out.includes("Manager share-1:"), "prints manager snapshot");
check(out.includes("Presence anchors missing:"), "prints missing presence details");
check(out.includes("Latest Warnings/Errors"), "prints error section");

console.log("diagnostics summary test");
console.log("ALL PASSED");

function check(condition, message) {
  if (condition) return;
  console.error(`FAILED: ${message}`);
  console.error(out);
  process.exit(1);
}
