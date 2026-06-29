import fs from "fs/promises";
import os from "os";
import path from "path";

process.env.PERSIST_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "backup-health-test-"));
process.env.REQUIRE_PERSIST_BACKUP = "true";
process.env.PERSIST_BACKUP_COMMAND = "true";
process.env.REQUIRE_SNAPSHOT_REMOTE = "true";
process.env.SNAPSHOT_GIT_REMOTE = "git@example.invalid:backup.git";

const { getBackupHealth } = await import("../src/backups.ts");
const { getSnapshotsHealth } = await import("../src/snapshots.ts");

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

console.log("server backup health\n");

{
  const health = getBackupHealth();
  check("required backup is unhealthy before first successful run", health.ok === false, JSON.stringify(health));
  check("required backup reports configured", health.configured === true && health.required === true, JSON.stringify(health));
  check("required backup has no success timestamp yet", health.lastBackupTs === 0, JSON.stringify(health));
}

{
  const health = getSnapshotsHealth();
  check("required snapshot remote is unhealthy before first successful push", health.ok === false, JSON.stringify(health));
  check("required snapshot remote reports configured", health.remoteConfigured === true && health.remoteRequired === true, JSON.stringify(health));
  check("required snapshot remote has no push timestamp yet", health.lastPushTs === 0, JSON.stringify(health));
}

await fs.rm(process.env.PERSIST_DIR, { recursive: true, force: true });

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
