import fs from "fs/promises";
import os from "os";
import path from "path";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

console.log("server share state\n");

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-collab-share-state-"));
process.env.PERSIST_DIR = tmp;
const { getInvite, getMinEpoch, putInvite, revokeInvite, setMinEpoch } = await import("../src/shareState.ts");

await putInvite("share-1", {
  id: "InviteABC123",
  role: "editor",
  epoch: 1,
  createdAt: 10,
  recipient: "Mira",
  expiresAt: 9999999999999,
});
check("invite can be read back", (await getInvite("share-1", "InviteABC123"))?.recipient === "Mira");

await setMinEpoch("share-1", 2);
check("epoch bump preserves invite", (await getInvite("share-1", "InviteABC123"))?.role === "editor");
check("min epoch bumped", await getMinEpoch("share-1") === 2);

await revokeInvite("share-1", "InviteABC123", 1234);
check("invite revocation persists", (await getInvite("share-1", "InviteABC123"))?.revokedAt === 1234);
check("missing invite revoke returns null", await revokeInvite("share-1", "missing") === null);

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
