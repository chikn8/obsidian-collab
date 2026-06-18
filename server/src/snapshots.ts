import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import * as Y from "yjs";
import { alertOps } from "./notify.js";
import { atomicWriteFile } from "./storage.js";

const exec = promisify(execFile);

const PERSIST_DIR = process.env.PERSIST_DIR || "./collab-data";
const SNAPSHOT_DIR = path.join(PERSIST_DIR, "snapshots");
const SNAPSHOT_INTERVAL = 5 * 60_000; // 5 minutes
const SNAPSHOT_GIT_REMOTE = process.env.SNAPSHOT_GIT_REMOTE || "";
const SNAPSHOT_GIT_BRANCH = process.env.SNAPSHOT_GIT_BRANCH || "main";

let snapshotTimer: ReturnType<typeof setInterval> | null = null;
let lastSnapshotWriteOk = true;
let lastSnapshotWriteTs = 0;
let lastSnapshotWriteError: string | null = null;
let lastCommitOk = true;
let lastCommitTs = 0;
let lastCommitError: string | null = null;
let lastPushOk = true;
let lastPushTs = 0;
let lastPushError: string | null = null;

function safeShareId(shareId: string): boolean {
  return /^[A-Za-z0-9_.-]{1,128}$/.test(shareId);
}

export function safeSnapshotRelPath(relPath: string): string | null {
  if (!relPath || relPath.startsWith("/") || relPath.includes("\\") || relPath.includes(":")) return null;
  if (/[\x00-\x1F\x7F]/.test(relPath)) return null;
  if (!/\.(md|canvas)$/i.test(relPath)) return null;
  const parts = relPath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join("/");
}

/**
 * Parse a room name into the share + relative file path we snapshot under.
 * Handles both legacy rooms ("file:<enc>") and namespaced share rooms
 * ("@<shareId>:file:<enc>"). Returns null for manifest/blob/other rooms.
 *
 * Legacy files keep their existing snapshots/<relPath> location (so existing
 * git history is not orphaned); namespaced shares write under snapshots/<shareId>/.
 */
function parseFileRoom(roomName: string): { shareId: string; relPath: string } | null {
  let rest = roomName;
  let shareId = "legacy";
  if (rest.startsWith("@")) {
    const idx = rest.indexOf(":");
    if (idx < 0) return null;
    shareId = rest.slice(1, idx);
    rest = rest.slice(idx + 1); // -> "file:..." | "blob:..." | "__manifest__"
  }
  // Only snapshot text file rooms; explicitly exclude blobs and manifest.
  if (!rest.startsWith("file:")) return null;
  const relPath = safeSnapshotRelPath(decodeURIComponent(rest.slice(5)));
  if (!safeShareId(shareId) || !relPath) return null;
  return { shareId, relPath };
}

/**
 * Write human-readable text files from Y.Doc state for a room.
 * Only writes text file rooms (skips __manifest__ and blob:).
 */
export async function writeSnapshot(roomName: string, ydoc: Y.Doc): Promise<void> {
  const parsed = parseFileRoom(roomName);
  if (!parsed) return;

  try {
    const filePath =
      parsed.shareId === "legacy"
        ? path.join(SNAPSHOT_DIR, parsed.relPath)
        : path.join(SNAPSHOT_DIR, parsed.shareId, parsed.relPath);

    const ytext = ydoc.getText("codemirror");
    const content = ytext.toString();

    // Only write if content is non-empty
    if (content.length === 0) return;

    try {
      const existing = await fs.readFile(filePath, "utf-8");
      if (existing === content) return; // No changes
    } catch {
      // File doesn't exist yet
    }

    await atomicWriteFile(filePath, content, "utf-8");
    lastSnapshotWriteOk = true;
    lastSnapshotWriteTs = Date.now();
    lastSnapshotWriteError = null;
  } catch (e: any) {
    lastSnapshotWriteOk = false;
    lastSnapshotWriteError = String(e?.message || e);
    await alertOps("snapshot-write", "ObsidianSync snapshot write failed", `${roomName}: ${lastSnapshotWriteError}`);
    throw e;
  }
}

/**
 * Initialize git repo in the snapshots directory and start auto-commit timer.
 */
export async function startSnapshots(): Promise<void> {
  await fs.mkdir(SNAPSHOT_DIR, { recursive: true });

  // Init git repo if needed
  try {
    await exec("git", ["status"], { cwd: SNAPSHOT_DIR });
  } catch {
    await exec("git", ["init"], { cwd: SNAPSHOT_DIR });
    await exec("git", ["symbolic-ref", "HEAD", `refs/heads/${SNAPSHOT_GIT_BRANCH}`], { cwd: SNAPSHOT_DIR });
    await exec("git", ["config", "user.name", "ObsidianSync"], { cwd: SNAPSHOT_DIR });
    await exec("git", ["config", "user.email", "sync@obsidian.local"], { cwd: SNAPSHOT_DIR });
    console.log("[snapshots] initialized git repo at", SNAPSHOT_DIR);
  }

  if (SNAPSHOT_GIT_REMOTE) await configureRemote();

  // Commit timer
  snapshotTimer = setInterval(() => {
    commitIfChanged().catch((e) => {
      console.error("[snapshots] auto-commit error:", e);
    });
  }, SNAPSHOT_INTERVAL);

  console.log("[snapshots] auto-commit every 5 minutes");
}

/**
 * Check for changes and commit if any exist.
 */
async function commitIfChanged(): Promise<void> {
  try {
    // Stage all changes
    await exec("git", ["add", "-A"], { cwd: SNAPSHOT_DIR });

    // Check if there's anything to commit
    const { stdout } = await exec("git", ["status", "--porcelain"], { cwd: SNAPSHOT_DIR });
    if (!stdout.trim()) {
      lastCommitOk = true;
      lastCommitError = null;
      return; // No changes
    }

    const now = new Date();
    const timestamp = now.toISOString().replace("T", " ").slice(0, 19);
    await exec("git", ["commit", "-m", `Auto-snapshot ${timestamp}`], { cwd: SNAPSHOT_DIR });
    await exec("git", ["gc", "--auto"], { cwd: SNAPSHOT_DIR }).catch((e) => {
      console.error("[snapshots] git gc failed:", e);
    });

    lastCommitOk = true;
    lastCommitTs = Date.now();
    lastCommitError = null;
    console.log(`[snapshots] committed at ${timestamp}`);
    await pushSnapshots();
  } catch (e: any) {
    // "nothing to commit" is not an error
    if (e.stderr?.includes("nothing to commit")) {
      lastCommitOk = true;
      lastCommitError = null;
      return;
    }
    lastCommitOk = false;
    lastCommitError = String(e?.stderr || e?.message || e);
    await alertOps("snapshot-commit", "ObsidianSync snapshot commit failed", lastCommitError);
    throw e;
  }
}

async function configureRemote(): Promise<void> {
  try {
    await exec("git", ["remote", "get-url", "origin"], { cwd: SNAPSHOT_DIR });
    await exec("git", ["remote", "set-url", "origin", SNAPSHOT_GIT_REMOTE], { cwd: SNAPSHOT_DIR });
  } catch {
    await exec("git", ["remote", "add", "origin", SNAPSHOT_GIT_REMOTE], { cwd: SNAPSHOT_DIR });
  }

  try {
    const { stdout } = await exec("git", ["branch", "--show-current"], { cwd: SNAPSHOT_DIR });
    if (stdout.trim() && stdout.trim() !== SNAPSHOT_GIT_BRANCH) {
      await exec("git", ["branch", "-M", SNAPSHOT_GIT_BRANCH], { cwd: SNAPSHOT_DIR });
    }
  } catch {
    // Empty repos may not have a current branch yet; symbolic-ref on init covers new repos.
  }
  console.log("[snapshots] git remote configured");
}

async function pushSnapshots(): Promise<void> {
  if (!SNAPSHOT_GIT_REMOTE) return;
  try {
    await exec("git", ["push", "origin", `HEAD:${SNAPSHOT_GIT_BRANCH}`], { cwd: SNAPSHOT_DIR });
    lastPushOk = true;
    lastPushTs = Date.now();
    lastPushError = null;
  } catch (e: any) {
    lastPushOk = false;
    lastPushError = String(e?.stderr || e?.message || e);
    console.error("[snapshots] git push failed:", lastPushError);
    await alertOps("snapshot-push", "ObsidianSync off-box snapshot push failed", lastPushError);
  }
}

export function stopSnapshots(): void {
  if (snapshotTimer) {
    clearInterval(snapshotTimer);
    snapshotTimer = null;
  }
}

export async function commitSnapshotsNow(): Promise<void> {
  await commitIfChanged();
}

export function getSnapshotsHealth() {
  return {
    ok: lastSnapshotWriteOk && lastCommitOk,
    lastSnapshotWriteOk,
    lastSnapshotWriteTs,
    lastSnapshotWriteError,
    lastCommitOk,
    lastCommitTs,
    lastCommitError,
    remoteConfigured: !!SNAPSHOT_GIT_REMOTE,
    lastPushOk,
    lastPushTs,
    lastPushError,
  };
}
