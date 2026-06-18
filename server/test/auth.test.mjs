import {
  ownerKey,
  roleKey,
  verifyOwnerAccess,
  verifyShareAccess,
} from "../src/auth.ts";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

console.log("server auth\n");

const serverSecret = "server-secret-for-tests";
const ownerSecret = "owner-secret-for-tests";
const shareId = "share-abc";
const epoch = 3;
const editor = roleKey(serverSecret, shareId, "editor", epoch);
const viewer = roleKey(serverSecret, shareId, "viewer", epoch);
const owner = ownerKey(ownerSecret, shareId, epoch);

check("role keys are role scoped", editor !== viewer);
check("editor token grants editor", verifyShareAccess(serverSecret, shareId, editor, "editor", epoch, 1) === "editor");
check("viewer token does not grant editor", verifyShareAccess(serverSecret, shareId, viewer, "editor", epoch, 1) === null);
check("owner key validates only with owner secret", verifyOwnerAccess(ownerSecret, shareId, owner, epoch, 1));
check("owner key is not a share access token", verifyShareAccess(serverSecret, shareId, owner, "editor", epoch, 1) === null);
check("revoked epoch rejects owner key", !verifyOwnerAccess(ownerSecret, shareId, owner, epoch, epoch + 1));
check("wrong share rejects owner key", !verifyOwnerAccess(ownerSecret, "other-share", owner, epoch, 1));

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
