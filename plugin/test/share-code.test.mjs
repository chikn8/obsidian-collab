import { decodeShareCode, encodeShareCode } from "../src/utils/roomName.ts";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

console.log("share code\n");

{
  const code = encodeShareCode("wss://relay.example", "share-1", "key-1", "editor", 3, "invite-1", 123456, "Team Notes");
  const decoded = decodeShareCode(code);
  check("round-trips optional label", decoded?.l === "Team Notes", JSON.stringify(decoded));
  check("preserves auth fields", decoded?.s === "wss://relay.example" && decoded?.id === "share-1" && decoded?.k === "key-1" && decoded?.r === "editor" && decoded?.e === 3 && decoded?.i === "invite-1" && decoded?.x === 123456);
}

{
  const code = encodeShareCode("wss://relay.example", "share-2", "key-2");
  const decoded = decodeShareCode(code);
  check("label is optional for old-style codes", decoded?.l === undefined && decoded?.id === "share-2", JSON.stringify(decoded));
}

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
