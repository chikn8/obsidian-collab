/**
 * Regression: vault "create" events that fire before the share's manifest has
 * synced (Obsidian emits one per existing file while it loads the vault) must
 * not be published. 2026-09-25: every launch minted a fresh fileId and a
 * "create" mutation for all ~296 files against an EMPTY local manifest; merged
 * with the server these overwrote rename/delete tombstones (the UGC folder
 * moved into Viewd kept coming back) and flipped fileIds, and each flip wiped
 * the file's local CRDT doc, which re-seeded (doubled) the note.
 *
 * Drives the REAL SyncManager over the in-memory obsidian fake.
 * Run: node test/run-startup-create.mjs
 */
import * as Y from "yjs";
import { App, TFile } from "obsidian";
import { SyncManager } from "../src/collab/SyncManager";

let failures = 0;
const check = (n, c, e = "") => { if (c) console.log(`  ✓ ${n}`); else { failures++; console.error(`  ✗ ${n} ${e}`); } };

const ls = new Map();
globalThis.window = { localStorage: {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => { ls.set(k, String(v)); },
  removeItem: (k) => { ls.delete(k); },
} };
globalThis.localStorage = globalThis.window.localStorage;

const FOLDER = "Share";
const SETTINGS = {
  serverUrl: "ws://fake", serverPassword: "", serverSecret: "", displayName: "Local", cursorColor: "",
  uid: "local-uid", identityPublicKey: "", identityPrivateKey: "", identitySignature: "",
  ntfyTopic: "", debugLogging: false, diagnosticLogging: false, clientTelemetry: false, shares: [],
};
const T_MOVE = Date.now() - 3 * 24 * 3600 * 1000; // the folder move, 3 days ago

function serverManifest() {
  const doc = new Y.Doc();
  doc.clientID = 1; // lower than the local doc: local concurrent writes win LWW
  const files = doc.getMap("files");
  doc.transact(() => {
    files.set("UGC/plan.md", {
      path: "UGC/plan.md", exists: false, deleted: true, fileId: "fid-plan", renamedTo: "Viewd/UGC/plan.md",
      mutationAction: "rename", mutationAt: T_MOVE, deletedAt: T_MOVE, mutationByUid: "peer", mutationDeviceId: "peer-dev",
    });
    files.set("Viewd/UGC/plan.md", {
      path: "Viewd/UGC/plan.md", exists: true, fileId: "fid-plan", renamedFrom: "UGC/plan.md",
      mutationAction: "rename", mutationAt: T_MOVE, mutationByUid: "peer", mutationDeviceId: "peer-dev",
    });
    files.set("notes.md", { path: "notes.md", exists: true, fileId: "fid-notes", mutationAction: "create", mutationAt: T_MOVE - 1000 });
  });
  return doc;
}

async function makeManager() {
  const app = new App();
  const manager = new SyncManager(app, SETTINGS, { id: "share1", label: "S", localFolder: FOLDER, role: "editor", epoch: 1, key: "k" },
    () => {}, () => {});
  const doc = new Y.Doc();
  doc.clientID = 0x7ffffff0;
  Object.assign(manager, {
    manifestDoc: doc,
    manifestMap: doc.getMap("files"),
    manifestMeta: doc.getMap("meta"),
    editsMap: doc.getMap("edits"),
    eventsArray: doc.getArray("events"),
  });
  const providersCreated = [];
  manager.createFileProvider = async (rel) => { providersCreated.push(rel); };
  return { app, manager, doc, providersCreated };
}

async function addFile(app, rel, { bornAt }) {
  const f = new TFile(`${FOLDER}/${rel}`, app.vault);
  f.stat = { ctime: bornAt, mtime: bornAt, size: 10 };
  app.vault.tree.set(f.path, f);
  app.vault.content.set(f.path, `content of ${rel}\n`);
  return f;
}

console.log("startup vault creates vs the synced manifest\n");

console.log("Creates fired while the vault loads (before manifest sync) are not published");
{
  const { app, manager, doc } = await makeManager();
  // This device still has the pre-move copy on disk plus two synced files.
  const stale = await addFile(app, "UGC/plan.md", { bornAt: T_MOVE - 86400000 });
  const moved = await addFile(app, "Viewd/UGC/plan.md", { bornAt: T_MOVE });
  const notes = await addFile(app, "notes.md", { bornAt: T_MOVE - 5000 });
  for (const f of [stale, moved, notes]) manager.onFileCreate(f);

  check("no manifest writes before the manifest has synced", doc.getMap("files").size === 0,
    JSON.stringify([...doc.getMap("files").keys()]));

  // Manifest syncs: merge the server state, then the startup reconcile runs.
  const server = serverManifest();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(server));
  Y.applyUpdate(server, Y.encodeStateAsUpdate(doc));
  try { await manager.onManifestSynced(); } catch (e) { console.error("reconcile threw", e); }
  Y.applyUpdate(server, Y.encodeStateAsUpdate(doc));

  const files = server.getMap("files");
  const plan = files.get("UGC/plan.md");
  check("the move's tombstone survives (no resurrection)", plan && plan.exists === false && plan.renamedTo === "Viewd/UGC/plan.md",
    JSON.stringify(plan));
  check("moved file keeps its fileId", files.get("Viewd/UGC/plan.md")?.fileId === "fid-plan", JSON.stringify(files.get("Viewd/UGC/plan.md")));
  check("synced file keeps its fileId", files.get("notes.md")?.fileId === "fid-notes", JSON.stringify(files.get("notes.md")));
  check("synced file keeps its original mutation", files.get("notes.md")?.mutationAction === "create" &&
    files.get("notes.md")?.mutationAt === T_MOVE - 1000, JSON.stringify(files.get("notes.md")));

  console.log("A genuinely new note after sync is still published");
  const fresh = await addFile(app, "brand new.md", { bornAt: Date.now() });
  manager.onFileCreate(fresh);
  const e = doc.getMap("files").get("brand new.md");
  check("new file gets a live entry", e?.exists === true && !!e?.fileId, JSON.stringify(e));

  console.log("A new note at an old tombstoned path is still published");
  app.vault.tree.delete(stale.path);
  const again = await addFile(app, "UGC/plan.md", { bornAt: Date.now() });
  manager.onFileCreate(again);
  check("fresh file at a renamed-away path is published", doc.getMap("files").get("UGC/plan.md")?.exists === true,
    JSON.stringify(doc.getMap("files").get("UGC/plan.md")));
}

console.log("A fileId change at the same path keeps the local CRDT doc");
{
  const { app, manager, doc } = await makeManager();
  Object.assign(manager, { manifestReconciled: true });
  await addFile(app, "notes.md", { bornAt: T_MOVE });
  let cleared = 0;
  const fp = { destroyAndClearData: async () => { cleared++; }, destroy() {}, pendingOffline: () => 0 };
  manager.fileProviders.set("notes.md", fp);
  manager.fileIds.set("notes.md", "fid-old");
  doc.getMap("files").set("notes.md", { path: "notes.md", exists: true, fileId: "fid-new", mutationAction: "create", mutationAt: Date.now() });
  await manager.handleManifestChange([{ key: "notes.md", action: "update" }]);
  check("local doc data is not cleared", cleared === 0, `cleared=${cleared}`);
  check("the same provider stays attached", manager.fileProviders.get("notes.md") === fp);
  check("the new fileId is adopted", manager.fileIds.get("notes.md") === "fid-new", manager.fileIds.get("notes.md"));
}

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else { console.log("ALL PASSED"); process.exit(0); }
