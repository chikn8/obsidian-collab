#!/usr/bin/env node
import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node tools/diagnostics-summary.mjs <diagnostic-bundle.json|trace.jsonl>");
  process.exit(2);
}

const input = readInput(file);
const rows = input.rows;
if (rows.length === 0) {
  console.log("No diagnostic rows found.");
  process.exit(0);
}

const byEvent = countBy(rows, (r) => `${r.ns}.${r.event}`);
const byLevel = countBy(rows, (r) => r.level || "unknown");
const warnings = rows.filter((r) => r.level === "warn" || r.level === "error");
const writeRows = rows.filter((r) => r.ns === "file" && String(r.event).startsWith("write-"));
const echoRows = rows.filter((r) => r.ns === "echo" || r.ns === "loop");
const presenceRows = rows.filter((r) => r.ns === "presence");
const manifestRows = rows.filter((r) => r.ns === "manifest");
const bindRows = rows.filter((r) => r.ns === "bind");
const skippedRows = rows.filter((r) => String(r.event).endsWith("-skipped") || field(r, "cause"));
const suspiciousPaths = repeatedWritePaths(writeRows);

section("Summary");
line("Rows", rows.length);
line("Time range", `${rowStamp(rows[0])} -> ${rowStamp(rows[rows.length - 1])}`);
line("Levels", formatCounts(byLevel));
line("Warnings/errors", warnings.length);
if (input.context) {
  section("Bundle Context");
  printContext(input.context);
}

section("Top Events");
for (const [key, count] of top(byEvent, 15)) line(key, count);

section("Sync Write Signals");
line("Write rows", writeRows.length);
line("Repeated writes by path", suspiciousPaths.length || "none");
for (const item of suspiciousPaths.slice(0, 10)) {
  line(item.path, `${item.count} write-start/write-ok rows`);
}
line("Echo/loop rows", echoRows.length);
for (const [key, count] of top(countBy(echoRows, (r) => `${r.ns}.${r.event}`), 10)) line(key, count);

section("Skipped/Drop Signals");
line("Skipped rows", skippedRows.length);
for (const [key, count] of top(countBy(skippedRows, (r) => `${r.ns}.${r.event}:${field(r, "cause") || "no-cause"}`), 12)) line(key, count);
const providerMissing = skippedRows.filter((r) => field(r, "cause") === "provider-missing");
if (providerMissing.length > 0) {
  console.log("");
  console.log("Recent provider-missing events:");
  for (const row of providerMissing.slice(-8)) {
    console.log(`- ${rowStamp(row)} ${field(row, "path") || field(row, "relPath") || ""}`);
  }
}

section("Presence Signals");
for (const [key, count] of top(countBy(presenceRows, (r) => r.event), 10)) line(key, count);
const missingPresence = presenceRows.filter((r) => String(r.event).includes("missing"));
if (missingPresence.length > 0) {
  console.log("");
  console.log("Presence anchors missing:");
  for (const row of missingPresence.slice(-10)) {
    console.log(`- ${rowStamp(row)} ${row.event} ${field(row, "path") || ""}`);
  }
}

section("Active Editor / Lifecycle Signals");
for (const [key, count] of top(countBy(bindRows, (r) => r.event), 12)) line(key, count);
const lifecycleRows = bindRows.filter((r) => String(r.event).startsWith("lifecycle-flush"));
if (lifecycleRows.length > 0) {
  console.log("");
  console.log("Recent lifecycle flushes:");
  for (const row of lifecycleRows.slice(-10)) {
    console.log(`- ${rowStamp(row)} ${row.event} ${compactFields(row.fields)}`);
  }
}
const editorBoundRows = rows.filter((r) => r.ns === "bind" && r.event === "editor-bound");
line("Editor-bound transitions", editorBoundRows.length);

section("Manifest Mutation Signals");
const mutationRows = manifestRows.filter((r) => field(r, "mutationId"));
line("Mutation-stamped rows", mutationRows.length);
for (const [key, count] of top(countBy(mutationRows, (r) => field(r, "mutationAction") || "unknown"), 10)) line(key, count);
if (mutationRows.length > 0) {
  console.log("");
  console.log("Recent manifest mutations:");
  for (const row of mutationRows.slice(-10)) {
    console.log(`- ${rowStamp(row)} ${field(row, "relPath") || ""} ${field(row, "mutationAction") || ""} ${field(row, "mutationId") || ""}`);
  }
}

if (warnings.length > 0) {
  section("Latest Warnings/Errors");
  for (const row of warnings.slice(-12)) {
    console.log(`- ${rowStamp(row)} [${row.level}] ${row.ns}.${row.event} ${compactFields(row.fields)}`);
  }
}

section("Latest Events");
for (const row of rows.slice(-20)) {
  console.log(`- ${rowStamp(row)} [${row.level}] ${row.ns}.${row.event} ${compactFields(row.fields)}`);
}

function readInput(path) {
  const body = fs.readFileSync(path, "utf8");
  if (path.endsWith(".jsonl")) {
    return { rows: body.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) };
  }
  const parsed = JSON.parse(body);
  if (Array.isArray(parsed)) return { rows: parsed };
  if (Array.isArray(parsed.rows)) return { rows: parsed.rows, context: parsed.context };
  throw new Error("Expected a diagnostic bundle with .rows or a JSONL trace");
}

function countBy(items, keyFn) {
  const out = new Map();
  for (const item of items) {
    const key = keyFn(item);
    out.set(key, (out.get(key) || 0) + 1);
  }
  return out;
}

function top(counts, n) {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, n);
}

function repeatedWritePaths(writeRows) {
  const counts = countBy(
    writeRows.filter((r) => r.event === "write-start" || r.event === "write-ok"),
    (r) => field(r, "path") || "(unknown)"
  );
  return top(counts, counts.size)
    .filter(([, count]) => count >= 8)
    .map(([path, count]) => ({ path, count }));
}

function section(title) {
  console.log("");
  console.log(`${title}`);
  console.log("-".repeat(title.length));
}

function line(label, value) {
  console.log(`${label}: ${value}`);
}

function formatCounts(counts) {
  return [...counts.entries()].map(([k, v]) => `${k}=${v}`).join(", ") || "none";
}

function printContext(context) {
  const plugin = context.plugin || {};
  const platform = context.platform || {};
  const settings = context.settings || {};
  const runtime = context.runtime || {};
  const diagnostics = context.diagnostics || {};
  line("Plugin", [plugin.id, plugin.version].filter(Boolean).join("@") || "unknown");
  line("Platform", formatFlags(platform, ["desktop", "mobile", "desktopApp", "mobileApp", "ios", "android", "phone", "tablet"]));
  line("Shares", `count=${settings.shareCount ?? "?"}, legacy=${settings.legacyShareCount ?? "?"}, roles=${JSON.stringify(settings.roles || {})}`);
  line("Settings", `ntfy=${bool(settings.ntfyConfigured)}, customColor=${bool(settings.customCursorColor)}`);
  line("Runtime", `managers=${runtime.managerCount ?? "?"}, bound=${runtime.boundPath || "none"}, ready=${bool(runtime.boundProviderReady)}, presence=${bool(runtime.boundHasPresence)}`);
  if (Array.isArray(runtime.managers) && runtime.managers.length > 0) {
    for (const manager of runtime.managers) {
      line(
        `Manager ${manager.shareId || manager.configuredShareId || "?"}`,
        `status=${manager.status || "?"}, role=${manager.role || "?"}, files=${manager.fileProviders ?? "?"}, pending=${manager.pendingOffline ?? "?"}, fileHosts=${manager.renderedFilePresenceHosts ?? "?"}, tabHosts=${manager.renderedTabPresenceHosts ?? "?"}, missingAnchors=${bool(manager.lastPresenceHadMissingAnchors)}, anchorRetries=${manager.presenceAnchorRetryCount ?? 0}`
      );
    }
  }
  line("Trace", `active=${bool(diagnostics.traceActive)}, rows=${diagnostics.rowCount ?? "?"}/${diagnostics.maxRows ?? "?"}, lines=${diagnostics.traceLineCount ?? "?"}/${diagnostics.maxTraceLines ?? "?"}, droppedRows=${diagnostics.droppedRows ?? 0}, droppedLines=${diagnostics.droppedTraceLines ?? 0}, nextSeq=${diagnostics.nextSeq ?? "?"}, path=${diagnostics.tracePath || "?"}`);
}

function formatFlags(obj, keys) {
  const active = keys.filter((key) => obj[key]);
  return active.length ? active.join(", ") : "none";
}

function bool(value) {
  return value === true ? "yes" : value === false ? "no" : "?";
}

function field(row, key) {
  return row?.fields && Object.prototype.hasOwnProperty.call(row.fields, key) ? row.fields[key] : undefined;
}

function rowStamp(row) {
  if (!row) return "?";
  const seq = row.seq != null ? `#${row.seq} ` : "";
  const dt = row.dt != null ? ` +${row.dt}ms` : "";
  return `${seq}${row.ts || "?"}${dt}`;
}

function compactFields(fields) {
  if (!fields || typeof fields !== "object") return "";
  const keep = {};
  for (const key of ["shareId", "path", "relPath", "room", "reason", "cause", "len", "oldLen", "newLen", "status", "error", "providers", "activeFiles", "fileMissing", "tabMissing", "mutationId", "mutationAction", "mutationDeviceId", "hasProvider", "bound", "ready"]) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) keep[key] = fields[key];
  }
  const keys = Object.keys(keep);
  return keys.length ? JSON.stringify(keep) : "";
}
