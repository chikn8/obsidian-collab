import { createHash } from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import * as Y from "yjs";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function blobPath(root, shareId, hash) {
  return path.join(root, "blobs", shareId, hash.slice(0, 2), hash);
}

async function writeManifest(root, shareId, entries) {
  const doc = new Y.Doc();
  const files = doc.getMap("files");
  for (const [relPath, entry] of Object.entries(entries)) files.set(relPath, entry);
  const room = `@${shareId}:__manifest__`;
  await fs.writeFile(path.join(root, `${encodeURIComponent(room)}.yjs`), Y.encodeStateAsUpdate(doc));
  doc.destroy();
}

console.log("server blob gc\n");

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-collab-blob-gc-"));
process.env.PERSIST_DIR = tmp;

const { storeBlob, loadBlob } = await import("../src/blobs.ts");
const { sweepOrphanBlobs } = await import("../src/blobGc.ts");

const shareId = "share-gc";
const referencedBody = Buffer.from("referenced");
const orphanBody = Buffer.from("orphan");
const youngBody = Buffer.from("young");
const referencedHash = sha256(referencedBody);
const orphanHash = sha256(orphanBody);
const youngHash = sha256(youngBody);

try {
  await storeBlob(shareId, referencedHash, referencedBody);
  await storeBlob(shareId, orphanHash, orphanBody);
  await writeManifest(tmp, shareId, {
    "deleted-image.png": {
      kind: "binary",
      exists: false,
      blobHash: referencedHash,
      blobSize: referencedBody.byteLength,
      lastModified: Date.now(),
    },
  });

  const dryRun = await sweepOrphanBlobs({ dryRun: true, graceMs: 0 });
  check("dry run finds orphan", dryRun.deleted === 1, JSON.stringify(dryRun));
  check("dry run keeps orphan file", (await loadBlob(shareId, orphanHash))?.equals(orphanBody));
  check("tombstoned manifest blob is referenced", dryRun.retainedReferenced === 1, JSON.stringify(dryRun));

  const real = await sweepOrphanBlobs({ dryRun: false, graceMs: 0 });
  check("real sweep deletes orphan", real.deleted === 1, JSON.stringify(real));
  check("orphan blob removed", await loadBlob(shareId, orphanHash) === null);
  check("referenced tombstone blob remains", (await loadBlob(shareId, referencedHash))?.equals(referencedBody));

  await storeBlob(shareId, youngHash, youngBody);
  const young = await sweepOrphanBlobs({ dryRun: false, graceMs: 60_000 });
  check("young orphan is retained by grace window", young.retainedYoung === 1, JSON.stringify(young));
  check("young orphan file remains", (await loadBlob(shareId, youngHash))?.equals(youngBody));

  await fs.utimes(blobPath(tmp, shareId, youngHash), new Date(0), new Date(0));
  const aged = await sweepOrphanBlobs({ dryRun: false, graceMs: 1 });
  check("aged orphan deletes after grace", aged.deleted === 1, JSON.stringify(aged));
  check("aged orphan file removed", await loadBlob(shareId, youngHash) === null);

  // Fail-closed: an unreadable manifest must retain that share's blobs.
  const badShare = "share-bad";
  const badBody = Buffer.from("behind-corrupt-manifest");
  const badHash = sha256(badBody);
  await storeBlob(badShare, badHash, badBody);
  await fs.utimes(blobPath(tmp, badShare, badHash), new Date(0), new Date(0));
  await fs.writeFile(path.join(tmp, `${encodeURIComponent(`@${badShare}:__manifest__`)}.yjs`), Buffer.from("not a yjs update"));
  const origErr = console.error;
  console.error = () => {};
  let unreadable;
  try {
    unreadable = await sweepOrphanBlobs({ dryRun: false, graceMs: 1 });
  } finally {
    console.error = origErr;
  }
  check("unreadable manifest retains its share's blobs", unreadable.retainedUnreadable === 1 && unreadable.deleted === 0, JSON.stringify(unreadable));
  check("blob behind corrupt manifest remains", (await loadBlob(badShare, badHash))?.equals(badBody));
  await fs.rm(path.join(tmp, `${encodeURIComponent(`@${badShare}:__manifest__`)}.yjs`));

  // Fail-closed: a share with NO manifest at all (quarantined / fresh volume)
  // must also be retained, not treated as unreferenced.
  const ghostShare = "share-ghost";
  const ghostBody = Buffer.from("no-manifest-anywhere");
  const ghostHash = sha256(ghostBody);
  await storeBlob(ghostShare, ghostHash, ghostBody);
  await fs.utimes(blobPath(tmp, ghostShare, ghostHash), new Date(0), new Date(0));
  const ghost = await sweepOrphanBlobs({ dryRun: false, graceMs: 1 });
  check("share without manifest is retained", ghost.retainedNoManifest >= 1 && ghost.deleted === 0, JSON.stringify(ghost));
  check("blob without manifest remains", (await loadBlob(ghostShare, ghostHash))?.equals(ghostBody));

  // Fail-closed: PERSIST_DIR unreadable → sweep aborts, deletes nothing.
  await fs.rm(tmp, { recursive: true, force: true });
  const abortedSweep = await sweepOrphanBlobs({ dryRun: false, graceMs: 1 });
  check("missing persist dir aborts the sweep", abortedSweep.aborted === true && abortedSweep.deleted === 0, JSON.stringify(abortedSweep));
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
