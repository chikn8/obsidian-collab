import { exec } from "child_process";
import { promisify } from "util";
import { alertOps } from "./notify.js";
import { PERSIST_DIR } from "./persistence.js";

const execShell = promisify(exec);

const BACKUP_COMMAND = process.env.PERSIST_BACKUP_COMMAND || "";
const REQUIRE_PERSIST_BACKUP = process.env.REQUIRE_PERSIST_BACKUP === "true";
const BACKUP_INTERVAL_MS = Number(process.env.PERSIST_BACKUP_INTERVAL_MS || 24 * 60 * 60_000);
const BACKUP_JITTER_MS = Number(process.env.PERSIST_BACKUP_JITTER_MS || 5 * 60_000);
const BACKUP_TIMEOUT_MS = Number(process.env.PERSIST_BACKUP_TIMEOUT_MS || 30 * 60_000);

let backupTimer: ReturnType<typeof setTimeout> | null = null;
let lastBackupOk = true;
let lastBackupTs = 0;
let lastBackupError: string | null = null;

export function startBackups(): void {
  if (!BACKUP_COMMAND) return;
  const firstDelay = Math.floor(Math.random() * BACKUP_JITTER_MS);
  backupTimer = setTimeout(runAndSchedule, firstDelay);
  console.log("[backups] scheduled PERSIST_DIR backups");
}

export function stopBackups(): void {
  if (backupTimer) {
    clearTimeout(backupTimer);
    backupTimer = null;
  }
}

async function runAndSchedule(): Promise<void> {
  await runBackup();
  backupTimer = setTimeout(runAndSchedule, BACKUP_INTERVAL_MS);
}

async function runBackup(): Promise<void> {
  try {
    await execShell(BACKUP_COMMAND, {
      env: { ...process.env, PERSIST_DIR },
      timeout: BACKUP_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    lastBackupOk = true;
    lastBackupTs = Date.now();
    lastBackupError = null;
    console.log("[backups] completed PERSIST_DIR backup");
  } catch (e: any) {
    lastBackupOk = false;
    lastBackupError = String(e?.stderr || e?.message || e);
    console.error("[backups] backup failed:", lastBackupError);
    await alertOps("persist-backup", "ObsidianSync off-box backup failed", lastBackupError);
  }
}

export function getBackupHealth() {
  const stale =
    !!BACKUP_COMMAND &&
    lastBackupTs > 0 &&
    Date.now() - lastBackupTs > BACKUP_INTERVAL_MS * 2;
  return {
    ok: (!REQUIRE_PERSIST_BACKUP || !!BACKUP_COMMAND) && (!BACKUP_COMMAND || (lastBackupOk && !stale)),
    configured: !!BACKUP_COMMAND,
    required: REQUIRE_PERSIST_BACKUP,
    lastBackupOk,
    lastBackupTs,
    lastBackupError,
    stale,
    intervalMs: BACKUP_INTERVAL_MS,
  };
}
