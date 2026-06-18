import { createHash } from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

console.log("server blobs\n");

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-collab-blobs-"));
process.env.PERSIST_DIR = tmp;
const {
  loadBlob,
  safeBlobHash,
  safeBlobRelPath,
  storeBlob,
} = await import("../src/blobs.ts");

const body = Buffer.from("blob bytes");
const hash = createHash("sha256").update(body).digest("hex");

check("accepts image path", safeBlobRelPath("assets/photo.png") === "assets/photo.png");
check("accepts pdf path", safeBlobRelPath("docs/spec.pdf") === "docs/spec.pdf");
check("rejects traversal", safeBlobRelPath("../photo.png") === null);
check("rejects unsupported extension", safeBlobRelPath("scripts/run.js") === null);
check("validates hash shape", safeBlobHash(hash) && !safeBlobHash("nope"));

await storeBlob("share-1", hash, body);
check("stored blob can be read", (await loadBlob("share-1", hash))?.equals(body));
let mismatchRejected = false;
try {
  await storeBlob("share-1", "0".repeat(64), body);
} catch {
  mismatchRejected = true;
}
check("hash mismatch rejects", mismatchRejected);
check("missing blob returns null", await loadBlob("share-1", "1".repeat(64)) === null);

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
