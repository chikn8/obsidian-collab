import { sanitizeAwarenessStateForTest } from "../src/rooms.ts";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

console.log("server awareness\n");

const identity = {
  uid: "real-user",
  name: "Real User",
  color: "#54a0ff",
  device: "desktop",
  deviceId: "device-1",
};

{
  const state = {
    user: {
      uid: "spoofed-user",
      name: "Spoofed",
      displayName: "Plain User",
      color: "#ff0000",
      device: "mobile",
      deviceId: "wrong-device",
    },
    presence: { activeFile: "note.md", typing: true },
    cursor: { anchor: 1, head: 1 },
  };
  const next = sanitizeAwarenessStateForTest(state, identity);
  check("overwrites spoofed uid", next.user.uid === identity.uid, next.user.uid);
  check("overwrites spoofed display fields", next.user.name === identity.name && next.user.color === identity.color);
  check("preserves plain display name", next.user.displayName === "Plain User", next.user.displayName);
  check("keeps non-identity awareness fields", next.presence.activeFile === "note.md" && next.cursor.head === 1);
}

{
  check("null awareness stays null", sanitizeAwarenessStateForTest(null, identity) === null);
}

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
