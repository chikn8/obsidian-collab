import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import { commenterSyncMessagePreservesTextForTest } from "../src/rooms.ts";

const MESSAGE_SYNC = 0;

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

function syncUpdateMessage(update) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

console.log("server room permissions\n");

const base = new Y.Doc();
base.getText("codemirror").insert(0, "hello");
const baseState = Y.encodeStateAsUpdate(base);
const baseVector = Y.encodeStateVector(base);

{
  const client = new Y.Doc();
  Y.applyUpdate(client, baseState);
  const comments = client.getMap("comments");
  const thread = new Y.Map();
  thread.set("quote", "hello");
  const replies = new Y.Array();
  const reply = new Y.Map();
  reply.set("text", "comment only");
  replies.push([reply]);
  thread.set("replies", replies);
  comments.set("c1", thread);
  const msg = syncUpdateMessage(Y.encodeStateAsUpdate(client, baseVector));
  check("commenter update that only changes comments is allowed",
    commenterSyncMessagePreservesTextForTest("@share:file:note.md", baseState, msg));
}

{
  const client = new Y.Doc();
  Y.applyUpdate(client, baseState);
  client.getText("codemirror").insert(5, "!");
  const msg = syncUpdateMessage(Y.encodeStateAsUpdate(client, baseVector));
  check("commenter update that changes text is rejected",
    !commenterSyncMessagePreservesTextForTest("@share:file:note.md", baseState, msg));
}

{
  const client = new Y.Doc();
  Y.applyUpdate(client, baseState);
  client.getMap("comments").set("c1", new Y.Map());
  const msg = syncUpdateMessage(Y.encodeStateAsUpdate(client, baseVector));
  check("commenter updates are not allowed on non-file rooms",
    !commenterSyncMessagePreservesTextForTest("@share:__manifest__", baseState, msg));
}

base.destroy();

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
