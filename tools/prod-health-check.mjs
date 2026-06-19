#!/usr/bin/env node
const url = process.argv[2] || "https://obsidiansync-production.up.railway.app/health";

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

const res = await fetch(url);
const body = await res.json().catch(() => null);
if (!body) {
  fail(`health endpoint did not return JSON (${res.status})`);
  process.exit();
}

console.log(`health ${url}`);
console.log(`status=${body.status} http=${res.status}`);
console.log(`persistence.ok=${body.persistence?.ok} freeBytes=${body.persistence?.freeBytes ?? "?"}`);
console.log(`snapshots.ok=${body.snapshots?.ok} remoteConfigured=${body.snapshots?.remoteConfigured} remoteRequired=${body.snapshots?.remoteRequired}`);
console.log(`backups.ok=${body.backups?.ok} configured=${body.backups?.configured} required=${body.backups?.required}`);
console.log(`opsAlerts.ok=${body.opsAlerts?.ok} configured=${body.opsAlerts?.configured} required=${body.opsAlerts?.required}`);

if (res.status !== 200 || body.status !== "ok") fail("service health is not ok");
if (!body.persistence?.ok) fail("persistence health is degraded");
if (!body.snapshots?.ok) fail("snapshot health is degraded");
if (!body.shareState?.ok) fail("share-state health is degraded");
if (!body.backups?.ok) fail("backup health is degraded");
if (body.opsAlerts?.ok === false) fail("ops alert health is degraded");
if (!body.snapshots?.remoteConfigured) fail("SNAPSHOT_GIT_REMOTE is not configured");
if (!body.backups?.configured) fail("PERSIST_BACKUP_COMMAND is not configured");
if (!body.opsAlerts?.configured) fail("OPS_NTFY_TOPIC is not configured");

if (!process.exitCode) console.log("PASS production durability gate passed");
