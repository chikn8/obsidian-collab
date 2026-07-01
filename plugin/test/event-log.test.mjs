import * as Y from "yjs";
import { appendEvent, formatEvent, listEvents } from "../src/collab/EventLog.ts";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

console.log("activity event log\n");

const doc = new Y.Doc();
const events = doc.getArray("events");

appendEvent(events, {
  type: "message",
  shareId: "share-a",
  actorUid: "uid-a",
  actorName: "Elijah",
  deviceId: "device-a",
  text: "hello",
}, 3);
appendEvent(events, {
  type: "open",
  shareId: "share-a",
  actorUid: "uid-a",
  actorName: "Elijah",
  deviceId: "device-a",
  path: "Project/Note.md",
}, 3);
appendEvent(events, {
  type: "edit",
  shareId: "share-a",
  actorUid: "uid-a",
  actorName: "Elijah",
  deviceId: "device-a",
  path: "Project/Note.md",
  count: 4,
  details: { token: "secret", safe: "ok" },
}, 3);
appendEvent(events, {
  type: "delete",
  shareId: "share-a",
  actorUid: "uid-b",
  actorName: "Friend",
  deviceId: "device-b",
  path: "Old.md",
}, 3);

const listed = listEvents(events, 10);
check("caps old events", listed.length === 3 && listed[0].type === "open");
check("formats edit compaction", formatEvent(listed[1]).includes("edited Project/Note.md 4 times"));
check("redacts details", !("token" in (listed[1].details || {})) && listed[1].details?.safe === "ok");
check("keeps chronological order", listed.map((e) => e.type).join(",") === "open,edit,delete");

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
