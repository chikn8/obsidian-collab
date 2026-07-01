import { spawn } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

function run(cmd, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

console.log("server git backup script\n");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, "..");
const script = path.join(serverRoot, "scripts", "git-full-backup.sh");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-collab-git-backup-test-"));
const persistDir = path.join(temp, "persist");
const bareRemote = path.join(temp, "backup.git");
const restoreDir = path.join(temp, "restore");

await fs.mkdir(path.join(persistDir, "share"), { recursive: true });
await fs.writeFile(path.join(persistDir, "share", "note.yjs"), "fake yjs state");
await fs.mkdir(path.join(persistDir, "snapshots", ".git", "objects"), { recursive: true });
await fs.writeFile(path.join(persistDir, "snapshots", ".git", "objects", "ignored"), "git internals");
await fs.writeFile(path.join(persistDir, "audit.jsonl"), "large retained audit log");

let result = await run("git", ["init", "--bare", bareRemote]);
check("bare remote init succeeds", result.code === 0, result.stderr);

result = await run("sh", [script], {
  cwd: serverRoot,
  env: {
    ...process.env,
    PERSIST_DIR: persistDir,
    SNAPSHOT_GIT_REMOTE: bareRemote,
    PERSIST_BACKUP_WORK_DIR: path.join(temp, "work"),
  },
});
check("backup script succeeds", result.code === 0, result.stderr || result.stdout);

result = await run("git", ["clone", "--branch", "backups", bareRemote, restoreDir]);
check("backup branch can be cloned", result.code === 0, result.stderr);

const latest = await fs.readFile(path.join(restoreDir, ".backup-meta", "latest.txt"), "utf-8").catch(() => "");
check("backup branch records timestamp", /^\d{4}-\d{2}-\d{2}T/.test(latest), latest);

const mirroredState = await fs.readFile(path.join(restoreDir, "share", "note.yjs"), "utf-8").catch(() => "");
check("backup branch mirrors persisted state", mirroredState === "fake yjs state", mirroredState);
await fs.access(path.join(restoreDir, "snapshots", ".git", "objects", "ignored"))
  .then(() => check("backup branch excludes snapshot git internals", false, "snapshot .git object copied"))
  .catch(() => check("backup branch excludes snapshot git internals", true));
await fs.access(path.join(restoreDir, "snapshots"))
  .then(() => check("backup branch excludes snapshots tree", false, "snapshots copied"))
  .catch(() => check("backup branch excludes snapshots tree", true));
await fs.access(path.join(restoreDir, "audit.jsonl"))
  .then(() => check("backup branch excludes retained audit log", false, "audit copied"))
  .catch(() => check("backup branch excludes retained audit log", true));

// A failing tar PRODUCER must abort the script before anything is pushed —
// the old `tar -cf - | tar -xf -` pipeline only surfaced the consumer's exit
// status, so partial copies were force-pushed over the last good backup.
if (process.getuid && process.getuid() !== 0) {
  const failPersist = path.join(temp, "persist-fail");
  const failRemote = path.join(temp, "backup-fail.git");
  await fs.mkdir(path.join(failPersist, "share"), { recursive: true });
  await fs.writeFile(path.join(failPersist, "share", "note.yjs"), "state");
  await fs.writeFile(path.join(failPersist, "share", "locked.yjs"), "unreadable");
  await fs.chmod(path.join(failPersist, "share", "locked.yjs"), 0o000);
  result = await run("git", ["init", "--bare", failRemote]);
  check("failure-case remote init succeeds", result.code === 0, result.stderr);
  result = await run("sh", [script], {
    cwd: serverRoot,
    env: {
      ...process.env,
      PERSIST_DIR: failPersist,
      SNAPSHOT_GIT_REMOTE: failRemote,
      PERSIST_BACKUP_WORK_DIR: path.join(temp, "work-fail"),
    },
  });
  check("tar producer failure aborts the script", result.code !== 0, `exit=${result.code}`);
  const branches = await run("git", ["--git-dir", failRemote, "branch", "--list"]);
  check("nothing was pushed after producer failure", !branches.stdout.includes("backups"), branches.stdout);
  await fs.chmod(path.join(failPersist, "share", "locked.yjs"), 0o644);
} else {
  console.log("  (skipped producer-failure case: running as root, chmod 000 is not enforced)");
}

console.log("");
if (failures > 0) { console.error(`FAILED - ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
