/**
 * Phase C regression: manifest identity, rename content-transfer, tombstones,
 * and the delete-vs-edit tombstone decision. Pure Yjs + the real manifest
 * helpers — runs headless.
 *
 * Run: node test/manifest.test.mjs  (or npm test runs both via the test script)
 */
import * as Y from "yjs";
import {
  conflictFileFromManifest,
  isRecoverableTombstone,
  liveManifestEntry,
  manifestMutationFields,
  safeRelPath,
  shouldApplyRenameSideEffects,
  shouldPublishLocalOnStartup,
  shouldResurrect,
  tombstoneLocalDecision,
  RESURRECT_GRACE_MS,
} from "../src/utils/manifestLogic.ts";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

// ── 1. Rename content-transfer: full Y.Doc clone preserves text + comments ─────
console.log("Rename content-transfer (full Y.Doc state clone)");
{
  const a = new Y.Doc();
  a.getText("codemirror").insert(0, "the quick brown fox");
  // a comment thread anchored into the text (mirrors CommentStore shape)
  const comments = a.getMap("comments");
  const thread = new Y.Map();
  thread.set("quote", "quick brown");
  thread.set("resolved", false);
  const replies = new Y.Array();
  const reply = new Y.Map();
  reply.set("text", "nice phrase");
  replies.push([reply]);
  thread.set("replies", replies);
  comments.set("c1", thread);

  // transfer = encode old doc state, apply into a fresh (new-room) doc
  const state = Y.encodeStateAsUpdate(a);
  const b = new Y.Doc();
  Y.applyUpdate(b, state, "seed");

  check("text transferred", b.getText("codemirror").toString() === "the quick brown fox");
  const bc = b.getMap("comments").get("c1");
  check("comment thread transferred", !!bc && bc.get("quote") === "quick brown");
  check("comment reply transferred",
    !!bc && bc.get("replies").length === 1 && bc.get("replies").get(0).get("text") === "nice phrase");

  // and the transferred doc still merges future edits with a peer (CRDT intact)
  const c = new Y.Doc();
  Y.applyUpdate(c, Y.encodeStateAsUpdate(b));
  b.getText("codemirror").insert(b.getText("codemirror").length, "!");
  c.getText("codemirror").insert(0, ">");
  Y.applyUpdate(b, Y.encodeStateAsUpdate(c));
  Y.applyUpdate(c, Y.encodeStateAsUpdate(b));
  check("transferred doc still CRDT-merges", b.getText("codemirror").toString() === c.getText("codemirror").toString(),
    `b="${b.getText("codemirror")}" c="${c.getText("codemirror")}"`);
}

// ── 2. fileId migration converges under concurrent assignment (LWW) ────────────
console.log("Manifest fileId migration converges (concurrent v1→v2)");
{
  const base = new Y.Doc();
  base.getMap("files").set("note.md", { exists: true, lastModified: 1 }); // v1, no fileId
  const baseState = Y.encodeStateAsUpdate(base);

  const c1 = new Y.Doc(); Y.applyUpdate(c1, baseState);
  const c2 = new Y.Doc(); Y.applyUpdate(c2, baseState);

  // both clients migrate independently, assigning DIFFERENT ids
  const e1 = c1.getMap("files").get("note.md");
  c1.getMap("files").set("note.md", { ...e1, fileId: "id-from-c1" });
  const e2 = c2.getMap("files").get("note.md");
  c2.getMap("files").set("note.md", { ...e2, fileId: "id-from-c2" });

  // sync both ways
  Y.applyUpdate(c1, Y.encodeStateAsUpdate(c2));
  Y.applyUpdate(c2, Y.encodeStateAsUpdate(c1));

  const f1 = c1.getMap("files").get("note.md").fileId;
  const f2 = c2.getMap("files").get("note.md").fileId;
  check("both clients converge to one fileId", f1 === f2 && !!f1, `f1=${f1} f2=${f2}`);
  check("schema migration is additive (entry still exists)", c1.getMap("files").get("note.md").exists === true);
}

// ── 3. Mixed-version old↔new manifest writes converge ────────────────────────
console.log("Mixed-version manifest migration");
{
  const newClient = new Y.Doc();
  const newFiles = newClient.getMap("files");
  newFiles.set("new-client.md", {
    exists: true,
    lastModified: 10,
    fileId: "id-new-client",
    mutationId: "new-mutation",
  });

  const oldClient = new Y.Doc();
  Y.applyUpdate(oldClient, Y.encodeStateAsUpdate(newClient));
  check("old client round-trip preserves unknown v2 fields",
    oldClient.getMap("files").get("new-client.md").fileId === "id-new-client");

  // Simulate an old client creating a valid v1-shaped entry after it has joined.
  oldClient.getMap("files").set("old-client.md", { exists: true, lastModified: 20, createdBy: "Old" });
  Y.applyUpdate(newClient, Y.encodeStateAsUpdate(oldClient));

  const migrateV2 = (doc, ids) => {
    const files = doc.getMap("files");
    doc.transact(() => {
      files.forEach((entry, relPath) => {
        if (entry && !entry.fileId) files.set(relPath, { ...entry, fileId: ids[relPath] });
      });
      doc.getMap("meta").set("schemaVersion", 2);
    });
  };
  migrateV2(newClient, { "old-client.md": "id-migrated-old-client" });
  migrateV2(newClient, { "old-client.md": "id-should-not-replace" });
  Y.applyUpdate(oldClient, Y.encodeStateAsUpdate(newClient));

  const migratedNew = newClient.getMap("files").get("old-client.md");
  const migratedOld = oldClient.getMap("files").get("old-client.md");
  check("new client migrates old-shaped entry",
    migratedNew.fileId === "id-migrated-old-client" && migratedNew.exists === true);
  check("migration is idempotent",
    migratedNew.fileId !== "id-should-not-replace");
  check("old and new clients converge after migration",
    migratedOld.fileId === migratedNew.fileId && migratedOld.createdBy === "Old");
  check("schema version marker is additive",
    newClient.getMap("meta").get("schemaVersion") === 2);
}

// ── 4. Delete is a retained tombstone, not a hard delete ──────────────────────
console.log("Delete = retained tombstone");
{
  const m = new Y.Doc();
  const files = m.getMap("files");
  files.set("x.md", { exists: true, fileId: "id", lastModified: 1 });
  // delete = set exists:false (NOT files.delete) so the entry replays + recovers
  const prev = files.get("x.md");
  files.set("x.md", { ...prev, exists: false, deleted: true, deletedAt: 5, deletedBy: "A" });

  check("tombstone entry retained", files.has("x.md") === true);
  check("tombstone marked not-exists", files.get("x.md").exists === false);
  check("tombstone keeps fileId (identity)", files.get("x.md").fileId === "id");
  // a "deleted files" scan finds it
  const deleted = [];
  files.forEach((e, k) => { if (e && e.exists === false) deleted.push(k); });
  check("deleted-files scan finds the tombstone", deleted.length === 1 && deleted[0] === "x.md");
}

// ── 4b. Rename link-repair side effects are single-writer ───────────────────
console.log("Rename side-effect ownership");
{
  const entry = {
    exists: true,
    renamedFrom: "Old.md",
    mutationByUid: "uid-a",
    mutationDeviceId: "device-a",
  };
  check("rename author applies side effects",
    shouldApplyRenameSideEffects(entry, "uid-a", "device-a") === true);
  check("another device skips side effects",
    shouldApplyRenameSideEffects(entry, "uid-a", "device-b") === false);
  check("another user skips side effects",
    shouldApplyRenameSideEffects(entry, "uid-b", "device-a") === false);
  check("missing provenance skips side effects",
    shouldApplyRenameSideEffects({ exists: true, renamedFrom: "Old.md" }, "uid-a", "device-a") === false);
}

// ── 5. Tombstone decision (delete-vs-edit) ────────────────────────────────────
console.log("Delete-vs-edit tombstone decision");
{
  const deletedAt = 100_000;
  check("edited well after delete → resurrect",
    shouldResurrect({ localMtime: deletedAt + RESURRECT_GRACE_MS + 1, deletedAt }) === true);
  check("decision: edited well after delete → resurrect",
    tombstoneLocalDecision({ localMtime: deletedAt + RESURRECT_GRACE_MS + 1, deletedAt }) === "resurrect");
  check("provenance: same-device tombstone deletes instead of resurrecting stale local file",
    tombstoneLocalDecision({
      localMtime: deletedAt + RESURRECT_GRACE_MS + 1,
      deletedAt,
      localUid: "uid-a",
      localDeviceId: "device-a",
      tombstoneUid: "uid-a",
      tombstoneDeviceId: "device-a",
    }) === "delete");
  check("provenance: cross-device apparent newer edit becomes conflict copy",
    tombstoneLocalDecision({
      localMtime: deletedAt + RESURRECT_GRACE_MS + 1,
      deletedAt,
      localUid: "uid-a",
      localDeviceId: "device-a",
      tombstoneUid: "uid-b",
      tombstoneDeviceId: "device-b",
    }) === "conflict-copy");
  check("local edit stamp: old tombstone apparent newer edit becomes conflict copy",
    tombstoneLocalDecision({
      localMtime: deletedAt + RESURRECT_GRACE_MS + 1,
      localEditAt: deletedAt + RESURRECT_GRACE_MS + 1,
      deletedAt,
      localUid: "uid-a",
      localDeviceId: "device-a",
      localEditUid: "uid-a",
      localEditDeviceId: "device-a",
    }) === "conflict-copy");
  check("local edit stamp: old tombstone still deletes clearly older local copy",
    tombstoneLocalDecision({
      localMtime: deletedAt - RESURRECT_GRACE_MS - 1,
      localEditAt: deletedAt - RESURRECT_GRACE_MS - 1,
      deletedAt,
      localEditUid: "uid-a",
      localEditDeviceId: "device-a",
    }) === "delete");
  check("untouched since before delete → do not resurrect",
    shouldResurrect({ localMtime: deletedAt - 5000, deletedAt }) === false);
  check("decision: untouched since before delete → delete",
    tombstoneLocalDecision({ localMtime: deletedAt - RESURRECT_GRACE_MS - 1, deletedAt }) === "delete");
  check("edited within grace window → do not resurrect directly",
    shouldResurrect({ localMtime: deletedAt + 500, deletedAt }) === false);
  check("decision: edited just after delete → conflict copy",
    tombstoneLocalDecision({ localMtime: deletedAt + 500, deletedAt }) === "conflict-copy");
  check("decision: edited just before delete → conflict copy",
    tombstoneLocalDecision({ localMtime: deletedAt - 500, deletedAt }) === "conflict-copy");
  check("rename tombstone never resurrects",
    shouldResurrect({ localMtime: deletedAt + 999999, deletedAt, renamedTo: "new.md" }) === false);
  check("decision: rename tombstone → delete",
    tombstoneLocalDecision({ localMtime: deletedAt + 999999, deletedAt, renamedTo: "new.md" }) === "delete");
}

// ── 6. Two-client delete/edit skew simulation ────────────────────────────────
console.log("Two-client delete/edit skew simulation");
{
  const deletedAt = 300_000;
  const editAt = deletedAt + RESURRECT_GRACE_MS + 10;
  const base = new Y.Doc();
  base.getMap("files").set("note.md", liveManifestEntry(undefined, "note.md", "id-note", "A", {
    kind: "text",
    lastModified: deletedAt - 10_000,
  }));
  const baseState = Y.encodeStateAsUpdate(base);

  const deleter = new Y.Doc(); Y.applyUpdate(deleter, baseState);
  const editor = new Y.Doc(); Y.applyUpdate(editor, baseState);

  // Client B edited locally while client A deleted with an old/no-provenance tombstone.
  editor.getMap("edits").set("note.md", { by: "B", byUid: "uid-b", deviceId: "device-b", at: editAt });
  const prev = deleter.getMap("files").get("note.md");
  deleter.getMap("files").set("note.md", {
    ...prev,
    exists: false,
    deleted: true,
    deletedAt,
    deletedBy: "A",
    lastModified: deletedAt,
  });

  Y.applyUpdate(editor, Y.encodeStateAsUpdate(deleter));
  const entry = editor.getMap("files").get("note.md");
  const localEdit = editor.getMap("edits").get("note.md");
  const decision = tombstoneLocalDecision({
    localMtime: editAt,
    deletedAt: entry.deletedAt,
    localUid: "uid-b",
    localDeviceId: "device-b",
    localEditAt: localEdit.at,
    localEditUid: localEdit.byUid,
    localEditDeviceId: localEdit.deviceId,
    tombstoneUid: entry.mutationByUid,
    tombstoneDeviceId: entry.mutationDeviceId,
  });
  check("skewed delete/edit resolves to conflict copy", decision === "conflict-copy", decision);

  const conflictRel = "note (delete conflict 2026-06-18T00-00-00-000Z).md";
  const mutation = manifestMutationFields({
    action: "delete-conflict-copy",
    at: editAt + 1,
    seq: 1,
    displayName: "B",
    uid: "uid-b",
    deviceId: "device-b",
    device: "desktop",
  });
  editor.getMap("files").set(conflictRel, liveManifestEntry(undefined, conflictRel, "id-conflict", "B", {
    kind: "text",
    ...mutation,
    resurrectedBy: "B",
    conflictOf: "note.md",
    conflictKind: "delete",
    conflictReason: "remote-delete",
    conflictBy: "B",
    conflictRemoteUpdatedAt: deletedAt,
    conflictLocalModifiedAt: editAt,
    conflictCreatedAt: mutation.mutationAt,
  }));
  Y.applyUpdate(deleter, Y.encodeStateAsUpdate(editor));

  check("original stays tombstoned on both clients",
    deleter.getMap("files").get("note.md").exists === false &&
    editor.getMap("files").get("note.md").exists === false);
  const conflictA = conflictFileFromManifest(conflictRel, deleter.getMap("files").get(conflictRel));
  const conflictB = conflictFileFromManifest(conflictRel, editor.getMap("files").get(conflictRel));
  check("conflict copy converges to both manifests",
    conflictA?.originalPath === "note.md" &&
    conflictA?.kind === "delete" &&
    conflictB?.originalPath === "note.md");
}

// ── 7. Startup reconciliation must not publish tombstoned local files ─────────
console.log("Startup tombstone ordering helpers");
{
  const tombstone = {
    fileId: "id",
    path: "x.md",
    exists: false,
    deleted: true,
    deletedAt: 200,
    deletedBy: "B",
    lastModified: 200,
  };
  check("missing manifest entry may be published",
    shouldPublishLocalOnStartup(undefined) === true);
  check("live manifest entry is not re-published",
    shouldPublishLocalOnStartup({ ...tombstone, exists: true, deleted: false }) === false);
  check("tombstone is not published before reconciliation",
    shouldPublishLocalOnStartup(tombstone) === false);
}

// ── 8. Live entry cleanup strips stale tombstone/rename metadata ───────────────
console.log("Live entry cleanup");
{
  const prior = {
    fileId: "id",
    path: "old.md",
    exists: false,
    deleted: true,
    deletedAt: 10,
    deletedBy: "A",
    renamedFrom: "older.md",
    renamedTo: "new.md",
    restoredBy: "old restore",
    restoredAt: 11,
    resurrectedBy: "old resurrect",
    mutationId: "old-op",
    mutationAction: "delete",
    mutationSeq: 1,
    mutationAt: 10,
    mutationBy: "A",
    mutationByUid: "uid-a",
    mutationDeviceId: "device-a",
    mutationDevice: "desktop",
    lastModified: 10,
    createdBy: "Orig",
  };
  const unstamped = liveManifestEntry(prior, "old.md", "id", "Me", { restoredBy: "Me", restoredAt: 20 });
  const mutation = manifestMutationFields({
    action: "restore",
    at: 20,
    seq: 2,
    displayName: "Me",
    uid: "uid-me",
    deviceId: "device-me",
    device: "mobile",
  });
  const live = liveManifestEntry(prior, "old.md", "id", "Me", { ...mutation, restoredBy: "Me", restoredAt: 20 });
  check("live entry exists", live.exists === true && live.deleted === false);
  check("live entry keeps identity", live.fileId === "id" && live.path === "old.md");
  check("live entry strips stale rename target", live.renamedTo === undefined && live.renamedFrom === undefined);
  check("live entry strips stale delete metadata", live.deletedAt === undefined && live.deletedBy === undefined);
  check("live entry strips stale mutation metadata", unstamped.mutationId === undefined && unstamped.mutationByUid === undefined);
  check("live entry applies fresh restore metadata", live.restoredBy === "Me" && live.restoredAt === 20);
  check("live entry applies fresh mutation metadata",
    live.mutationId === "uid-me:device-me:2:20" &&
    live.mutationAction === "restore" &&
    live.mutationByUid === "uid-me" &&
    live.mutationDevice === "mobile");
}

// ── 9. Deleted-files list should exclude rename-away tombstones ────────────────
console.log("Recoverable tombstone filter");
{
  check("normal delete is recoverable",
    isRecoverableTombstone({ exists: false, deleted: true, deletedAt: 1, lastModified: 1 }) === true);
  check("rename tombstone is not shown as deleted",
    isRecoverableTombstone({ exists: false, deleted: true, renamedTo: "b.md", deletedAt: 1, lastModified: 1 }) === false);
  check("live entry is not recoverable tombstone",
    isRecoverableTombstone({ exists: true, lastModified: 1 }) === false);
}

// ── 10. Conflict-copy manifest metadata powers the review list ───────────────
console.log("Conflict-copy manifest metadata");
{
  const entry = liveManifestEntry(undefined, "assets/photo (binary conflict 2026).png", "id-conflict", "Me", {
    kind: "binary",
    conflictOf: "assets/photo.png",
    conflictKind: "binary-update",
    conflictReason: "live",
    conflictCreatedAt: 123,
    conflictBy: "Me",
    conflictRemoteUpdatedAt: 100,
    conflictLocalModifiedAt: 101,
    conflictRemoteHash: "remote-hash",
    conflictLocalHash: "local-hash",
  });
  const conflict = conflictFileFromManifest("assets/photo (binary conflict 2026).png", entry);
  check("live conflict entry is listed",
    conflict?.relPath === "assets/photo (binary conflict 2026).png" &&
    conflict?.originalPath === "assets/photo.png" &&
    conflict?.kind === "binary-update" &&
    conflict?.localHash === "local-hash");
  check("plain live entry is not listed",
    conflictFileFromManifest("note.md", { exists: true, lastModified: 1 }) === null);
  check("tombstoned conflict entry is not listed",
    conflictFileFromManifest("old.md", { ...entry, exists: false, deleted: true }) === null);
}

// ── 11. Manifest relpaths are validated before touching the vault ─────────────
console.log("Safe manifest paths");
{
  check("accepts nested markdown path",
    safeRelPath("a/b/note.md", "Shared") === "a/b/note.md");
  check("accepts canvas path",
    safeRelPath("boards/plan.canvas", "Shared") === "boards/plan.canvas");
  check("accepts image attachment path",
    safeRelPath("images/photo.png", "Shared") === "images/photo.png");
  check("accepts pdf attachment path",
    safeRelPath("docs/file.pdf", "Shared") === "docs/file.pdf");
  check("rejects parent traversal",
    safeRelPath("../x.md", "Shared") === null);
  check("rejects normalized traversal",
    safeRelPath("a/../../b.md", "Shared") === null);
  check("rejects absolute path",
    safeRelPath("/etc/x.md", "Shared") === null);
  check("rejects windows separator",
    safeRelPath("..\\b.md", "Shared") === null);
  check("rejects colon",
    safeRelPath("a:b.md", "Shared") === null);
  check("rejects unsupported file type",
    safeRelPath("note.exe", "Shared") === null);
  check("rejects empty segment",
    safeRelPath("a//b.md", "Shared") === null);
  check("rejects control chars",
    safeRelPath("bad\u0000name.md", "Shared") === null);
}

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
