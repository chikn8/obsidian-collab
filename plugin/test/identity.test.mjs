import { webcrypto } from "node:crypto";
import { ensureIdentityKeys, verifyIdentityForTest } from "../src/utils/identity.ts";

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto });
}

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

console.log("signed client identity\n");

const uid = "user-identity-test";
const identity = await ensureIdentityKeys({}, uid);
check("generates public/private/signature", !!identity.publicKey && !!identity.privateKey && !!identity.signature);
check("signature verifies for uid", await verifyIdentityForTest(uid, identity.publicKey, identity.signature));
check("signature rejects another uid", !(await verifyIdentityForTest("other-user", identity.publicKey, identity.signature)));

const reused = await ensureIdentityKeys(identity, uid);
check("reuses existing keypair", reused.publicKey === identity.publicKey && reused.privateKey === identity.privateKey);
check("keeps valid signature", reused.signature === identity.signature);

const backfilled = await ensureIdentityKeys({ publicKey: identity.publicKey, privateKey: identity.privateKey }, uid);
check("backfills missing signature", await verifyIdentityForTest(uid, backfilled.publicKey, backfilled.signature));

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
