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
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
