import fs from "fs/promises";
import os from "os";
import path from "path";
import * as Y from "yjs";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function exists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch (e) {
    if (e?.code === "ENOENT") return false;
    throw e;
  }
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(10);
  }
  throw new Error(`${label} timed out`);
}

console.log("server persistence\n");

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-collab-persistence-"));
process.env.PERSIST_DIR = tmp;
process.env.MIN_FREE_BYTES = "0";
process.env.SAVE_SWEEP_INTERVAL_MS = "25";
process.env.STALE_SAVE_MS = "60";

const {
  getPersistenceHealth,
  loadState,
  markDirty,
  startPeriodicSave,
  stopPeriodicSave,
} = await import("../src/persistence.ts");

const room = "@persist:file:note.md";
const statePath = path.join(tmp, `${encodeURIComponent(room)}.yjs`);
const doc = new Y.Doc();

try {
  startPeriodicSave(room, doc);
  await sleep(80);
  check("clean active room does not write a state file", !(await exists(statePath)));

  let health = await getPersistenceHealth();
  check("clean active room is healthy", health.ok === true, JSON.stringify(health));
  check("clean active room has no dirty rooms", health.dirtyRooms === 0, JSON.stringify(health));

  doc.getText("codemirror").insert(0, "hello");
  markDirty(room);
  health = await getPersistenceHealth();
  check("dirty room is tracked before sweep", health.dirtyRooms === 1, JSON.stringify(health));

  await waitFor(async () => {
    const h = await getPersistenceHealth();
    return (await exists(statePath)) && h.dirtyRooms === 0;
  }, 1000, "dirty room save");
  check("dirty room wrote a state file", await exists(statePath));

  const loaded = new Y.Doc();
  await loadState(room, loaded);
  check("saved Yjs state reloads", loaded.getText("codemirror").toString() === "hello");

  const firstMtime = (await fs.stat(statePath)).mtimeMs;
  await sleep(90);
  const secondMtime = (await fs.stat(statePath)).mtimeMs;
  check("clean room is not repeatedly re-saved", secondMtime === firstMtime, `${firstMtime} -> ${secondMtime}`);

  stopPeriodicSave(room);
  health = await getPersistenceHealth();
  check("stopped room is no longer active", health.activeRooms === 0, JSON.stringify(health));
} finally {
  stopPeriodicSave(room);
  doc.destroy();
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
