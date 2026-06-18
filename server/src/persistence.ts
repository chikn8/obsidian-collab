import * as Y from "yjs";
import fs from "fs/promises";
import path from "path";
import { writeSnapshot } from "./snapshots.js";
import { alertOps } from "./notify.js";
import { atomicWriteFile } from "./storage.js";

export const PERSIST_DIR = process.env.PERSIST_DIR || "./collab-data";
const saveQueues: Map<string, Promise<void>> = new Map();
const activeRooms: Map<string, number> = new Map();
const STALE_SAVE_MS = Number(process.env.STALE_SAVE_MS || 3 * 60_000);
const MIN_FREE_BYTES = Number(process.env.MIN_FREE_BYTES || 100 * 1024 * 1024);

let lastSaveOk = true;
let lastSaveTs = 0;
let lastSaveError: string | null = null;

function statePath(roomName: string): string {
  return path.join(PERSIST_DIR, encodeURIComponent(roomName) + ".yjs");
}

async function enqueueSave(roomName: string, fn: () => Promise<void>): Promise<void> {
  const previous = saveQueues.get(roomName) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  saveQueues.set(roomName, next);
  try {
    await next;
  } finally {
    if (saveQueues.get(roomName) === next) saveQueues.delete(roomName);
  }
}

/**
 * Load a previously saved Y.Doc state from disk.
 */
export async function loadState(
  roomName: string,
  ydoc: Y.Doc
): Promise<void> {
  const filePath = statePath(roomName);

  try {
    const data = await fs.readFile(filePath);
    try {
      Y.applyUpdate(ydoc, new Uint8Array(data));
    } catch (e: any) {
      const corruptPath = `${filePath}.corrupt-${Date.now()}`;
      await fs.rename(filePath, corruptPath).catch((renameError) => {
        console.error(`[persistence] failed to quarantine corrupt state for ${roomName}:`, renameError);
      });
      console.error(`[persistence] corrupt state for ${roomName}; quarantined and starting empty:`, e);
      await alertOps(
        "yjs-corrupt",
        "ObsidianSync corrupt Yjs state",
        `Room ${roomName} had a corrupt .yjs file and was started empty. ${String(e?.message || e)}`
      );
      return;
    }
    console.log(`[persistence] loaded state for room: ${roomName}`);
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
    // File doesn't exist yet — fresh room
  }
}

/**
 * Save the current Y.Doc state to disk.
 */
export async function saveState(
  roomName: string,
  ydoc: Y.Doc
): Promise<void> {
  await enqueueSave(roomName, async () => {
    const filePath = statePath(roomName);
    const state = Y.encodeStateAsUpdate(ydoc);

    try {
      await atomicWriteFile(filePath, state);
      lastSaveOk = true;
      lastSaveTs = Date.now();
      lastSaveError = null;
    } catch (e: any) {
      lastSaveOk = false;
      lastSaveError = String(e?.message || e);
      await alertOps("yjs-save", "ObsidianSync Yjs save failed", `Room ${roomName}: ${lastSaveError}`);
      throw e;
    }

    // Also write human-readable snapshot for git history
    await writeSnapshot(roomName, ydoc).catch((e) => {
      console.error(`[persistence] snapshot write error for ${roomName}:`, e);
      void alertOps("snapshot-write", "ObsidianSync snapshot write failed", `Room ${roomName}: ${String(e?.message || e)}`);
    });

    console.log(`[persistence] saved state for room: ${roomName}`);
  });
}

const PERIODIC_SAVE_INTERVAL = 60_000; // 60 seconds

// Track active save intervals per room so we can clean them up
const saveIntervals: Map<string, ReturnType<typeof setInterval>> = new Map();

/**
 * Start periodic saving for a room while it has active connections.
 * Call this when the first client connects to a room.
 */
export function startPeriodicSave(roomName: string, ydoc: Y.Doc): void {
  if (saveIntervals.has(roomName)) return; // already running
  activeRooms.set(roomName, Date.now());

  const interval = setInterval(() => {
    saveState(roomName, ydoc).catch((e) => {
      console.error(`[persistence] periodic save error for ${roomName}:`, e);
    });
  }, PERIODIC_SAVE_INTERVAL);

  saveIntervals.set(roomName, interval);
  console.log(`[persistence] started periodic save for room: ${roomName}`);
}

/**
 * Stop periodic saving for a room.
 * Call this when the last client disconnects.
 */
export function stopPeriodicSave(roomName: string): void {
  activeRooms.delete(roomName);
  const interval = saveIntervals.get(roomName);
  if (interval) {
    clearInterval(interval);
    saveIntervals.delete(roomName);
    console.log(`[persistence] stopped periodic save for room: ${roomName}`);
  }
}

export async function getPersistenceHealth() {
  const now = Date.now();
  const oldestActiveTs = activeRooms.size > 0 ? Math.min(...activeRooms.values()) : 0;
  const stale =
    activeRooms.size > 0 &&
    now - (lastSaveTs || oldestActiveTs) > STALE_SAVE_MS;

  let freeBytes: number | null = null;
  let diskError: string | null = null;
  try {
    await fs.mkdir(PERSIST_DIR, { recursive: true });
    const stat = await fs.statfs(PERSIST_DIR);
    freeBytes = Number(stat.bavail) * Number(stat.bsize);
  } catch (e: any) {
    diskError = String(e?.message || e);
  }

  const diskLow = freeBytes !== null && freeBytes < MIN_FREE_BYTES;
  return {
    ok: lastSaveOk && !stale && !diskLow && !diskError,
    lastSaveOk,
    lastSaveTs,
    lastSaveAgeMs: lastSaveTs ? now - lastSaveTs : null,
    lastSaveError,
    activeRooms: activeRooms.size,
    stale,
    staleSaveMs: STALE_SAVE_MS,
    freeBytes,
    minFreeBytes: MIN_FREE_BYTES,
    diskLow,
    diskError,
  };
}
