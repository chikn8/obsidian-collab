import fs from "fs/promises";
import os from "os";
import path from "path";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

console.log("server notify\n");

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-collab-notify-"));
process.env.PERSIST_DIR = tmp;
process.env.NTFY_SERVER = "https://ntfy.invalid";

const sent = [];
globalThis.fetch = async (url, init) => {
  sent.push({ url, init });
  return { ok: true, status: 200 };
};

const { handleNotify, registerTopic } = await import("../src/notify.ts");

try {
  await registerTopic("share-1", "target", "topic_target");
  await handleNotify("share-1", {
    fromUid: "sender-a",
    fromName: "Sender",
    toUid: "target",
    title: "Mention",
    body: "hello",
    filePath: "Folder/Note.md",
  }, Date.now());

  check("mention sends to registered topic", sent.length === 1, `sent=${sent.length}`);
  check("valid note path becomes click header", sent[0]?.init?.headers?.Click === "obsidian://open?path=Folder%2FNote.md", sent[0]?.init?.headers?.Click);

  await handleNotify("share-1", {
    fromUid: "sender-b",
    fromName: "Sender",
    toUid: "target",
    title: "Mention",
    body: "bad",
    filePath: "obsidian://collab-add?code=evil",
  }, Date.now());
  check("arbitrary URL is not forwarded", !sent[1]?.init?.headers?.Click, sent[1]?.init?.headers?.Click);

  await handleNotify("share-1", {
    fromUid: "sender-c",
    fromName: "Sender",
    toUid: "target",
    title: "Mention",
    body: "bad",
    filePath: "../Outside.md",
  }, Date.now());
  check("traversal path is not forwarded", !sent[2]?.init?.headers?.Click, sent[2]?.init?.headers?.Click);
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
