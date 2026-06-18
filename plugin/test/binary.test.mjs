import { webcrypto } from "node:crypto";
import {
  buffersEqual,
  isSyncableBinaryPath,
  sha256Hex,
} from "../src/utils/binary.ts";

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto });
}

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

console.log("binary helpers\n");

const data = new TextEncoder().encode("attachment").buffer;
check("sha256 is stable hex", await sha256Hex(data) === "602a5e69c3021bdbd3d25156a02d2cbb467605b8203248eea6af3fb42168d663");
check("detects syncable image", isSyncableBinaryPath("images/photo.png"));
check("detects syncable pdf", isSyncableBinaryPath("docs/spec.pdf"));
check("rejects executable extension", !isSyncableBinaryPath("scripts/run.js"));
check("compares equal buffers", buffersEqual(data, data.slice(0)));
check("compares different buffers", !buffersEqual(data, new TextEncoder().encode("other").buffer));

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
