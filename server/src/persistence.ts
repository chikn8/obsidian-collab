import * as Y from "yjs";
import fs from "fs/promises";
import path from "path";
import { writeSnapshot } from "./snapshots.js";
import { alertOps } from "./notify.js";
import { atomicWriteFile } from "./storage.js";

export const PERSIST_DIR = process.env.PERSIST_DIR || "./collab-data";
const saveQueues: Map<string, Promise<void>> = new Map();
const activeRooms: Map<string, number> = new Map();
const activeDocs: Map<string, Y.Doc> = new Map();
const dirtyRooms: Map<string, { version: number; firstDirtyAt: number }> = new Map();
const dirtySaves: Set<string> = new Set();
const STALE_SAVE_MS = Number(process.env.STALE_SAVE_MS || 3 * 60_000);
const MIN_FREE_BYTES = Number(process.env.MIN_FREE_BYTES || 100 * 1024 * 1024);
const SAVE_SWEEP_INTERVAL = Number(process.env.SAVE_SWEEP_INTERVAL_MS || 60_000);

let lastSaveOk = true;
let lastSaveTs = 0;
let lastSaveError: string | null = null;
let saveSweepInterval: ReturnType<typeof setInterval> | null = null;

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
      Y.applyUpdate(ydoc, new Uint8Array(data), "load");
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
    const dirtyVersion = dirtyRooms.get(roomName)?.version;
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

    const currentDirty = dirtyRooms.get(roomName);
    if (dirtyVersion !== undefined && currentDirty?.version === dirtyVersion) dirtyRooms.delete(roomName);
    console.log(`[persistence] saved state for room: ${roomName}`);
  });
}

async function saveDirtyRoom(roomName: string, ydoc: Y.Doc): Promise<void> {
  const dirty = dirtyRooms.get(roomName);
  if (!dirty || dirtySaves.has(roomName)) return;
  dirtySaves.add(roomName);
  const version = dirty.version;
  try {
    await saveState(roomName, ydoc);
    const current = dirtyRooms.get(roomName);
    if (current?.version === version) dirtyRooms.delete(roomName);
  } catch (e) {
    console.error(`[persistence] dirty save error for ${roomName}:`, e);
  } finally {
    dirtySaves.delete(roomName);
  }
}

function ensureSaveSweep(): void {
  if (saveSweepInterval) return;
  saveSweepInterval = setInterval(() => {
    for (const [roomName, ydoc] of activeDocs) {
      if (dirtyRooms.has(roomName)) void saveDirtyRoom(roomName, ydoc);
    }
  }, SAVE_SWEEP_INTERVAL);
  console.log(`[persistence] started dirty save sweep every ${SAVE_SWEEP_INTERVAL}ms`);
}

function stopSaveSweepIfIdle(): void {
  if (activeDocs.size > 0 || !saveSweepInterval) return;
  clearInterval(saveSweepInterval);
  saveSweepInterval = null;
  console.log("[persistence] stopped dirty save sweep");
}

export function markDirty(roomName: string): void {
  const now = Date.now();
  const current = dirtyRooms.get(roomName);
  dirtyRooms.set(roomName, {
    version: (current?.version ?? 0) + 1,
    firstDirtyAt: current?.firstDirtyAt ?? now,
  });
}

/**
 * Register an active room for dirty-state saving while it has connections.
 * Call this when the first client connects to a room.
 */
export function startPeriodicSave(roomName: string, ydoc: Y.Doc): void {
  const alreadyActive = activeDocs.has(roomName);
  activeRooms.set(roomName, activeRooms.get(roomName) ?? Date.now());
  activeDocs.set(roomName, ydoc);
  ensureSaveSweep();
  if (!alreadyActive) console.log(`[persistence] tracking dirty saves for room: ${roomName}`);
}

/**
 * Stop dirty-state saving for a room.
 * Call this when the last client disconnects.
 */
export function stopPeriodicSave(roomName: string): void {
  const wasActive = activeDocs.delete(roomName);
  activeRooms.delete(roomName);
  dirtyRooms.delete(roomName);
  dirtySaves.delete(roomName);
  if (wasActive) console.log(`[persistence] stopped dirty save tracking for room: ${roomName}`);
  stopSaveSweepIfIdle();
}

export async function getPersistenceHealth() {
  const now = Date.now();
  const oldestDirtyTs = dirtyRooms.size > 0
    ? Math.min(...Array.from(dirtyRooms.values(), (dirty) => dirty.firstDirtyAt))
    : 0;
  const stale =
    dirtyRooms.size > 0 &&
    now - oldestDirtyTs > STALE_SAVE_MS;

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
    dirtyRooms: dirtyRooms.size,
    savingDirtyRooms: dirtySaves.size,
    stale,
    staleSaveMs: STALE_SAVE_MS,
    freeBytes,
    minFreeBytes: MIN_FREE_BYTES,
    diskLow,
    diskError,
  };
}
