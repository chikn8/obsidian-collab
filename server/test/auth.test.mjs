import { webcrypto } from "crypto";
import {
  identityPayload,
  inviteKey,
  ownerKey,
  roleKey,
  verifyIdentitySignature,
  verifyInviteAccess,
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
const futureExpiry = Date.now() + 60_000;
const invite = inviteKey(serverSecret, shareId, "commenter", epoch, "abc123XYZ", futureExpiry);

check("role keys are role scoped", editor !== viewer);
check("editor token grants editor", verifyShareAccess(serverSecret, shareId, editor, "editor", epoch, 1) === "editor");
check("viewer token does not grant editor", verifyShareAccess(serverSecret, shareId, viewer, "editor", epoch, 1) === null);
check("owner key validates only with owner secret", verifyOwnerAccess(ownerSecret, shareId, owner, epoch, 1));
check("owner key is not a share access token", verifyShareAccess(serverSecret, shareId, owner, "editor", epoch, 1) === null);
check("revoked epoch rejects owner key", !verifyOwnerAccess(ownerSecret, shareId, owner, epoch, epoch + 1));
check("wrong share rejects owner key", !verifyOwnerAccess(ownerSecret, "other-share", owner, epoch, 1));
check("invite token grants scoped role",
  verifyInviteAccess(serverSecret, shareId, invite, "commenter", epoch, "abc123XYZ", futureExpiry, 1) === "commenter");
check("invite token is invite scoped",
  verifyInviteAccess(serverSecret, shareId, invite, "commenter", epoch, "other123", futureExpiry, 1) === null);
check("expired invite rejects",
  verifyInviteAccess(serverSecret, shareId, inviteKey(serverSecret, shareId, "viewer", epoch, "abc123XYZ", Date.now() - 1), "viewer", epoch, "abc123XYZ", Date.now() - 1, 1) === null);

{
  const uid = "signed-user";
  const pair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const publicJwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  const publicKey = Buffer.from(JSON.stringify(publicJwk), "utf-8").toString("base64url");
  const signature = Buffer.from(await webcrypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    pair.privateKey,
    identityPayload(uid, publicKey)
  )).toString("base64url");

  check("identity signature verifies", await verifyIdentitySignature(publicKey, uid, signature));
  check("identity signature rejects another uid", !(await verifyIdentitySignature(publicKey, "other-user", signature)));
  check("identity signature rejects malformed key", !(await verifyIdentitySignature("not-json", uid, signature)));
}

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
