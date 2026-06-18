/**
 * Integration test: drives the REAL FileProvider (not a reimplementation) end to
 * end, with obsidian / y-indexeddb / y-websocket aliased to in-memory fakes (see
 * run-integration.mjs). This is the regression net the unit tests can't be — it
 * catches WIRING bugs: a missing echo.mark, an unhooked observer, a broken
 * offline reconcile would all pass the pure-unit suite but fail here.
 *
 * Run: node test/run-integration.mjs
 */
import * as Y from "yjs";
import { FileProvider } from "../src/collab/FileProvider";
import { EchoGuard } from "../src/collab/EchoGuard";
import { App } from "obsidian";
import { __resetIdb } from "y-indexeddb";
import { __resetHubs } from "y-websocket";

let failures = 0;
const check = (n, c, e = "") => { if (c) console.log(`  ✓ ${n}`); else { failures++; console.error(`  ✗ ${n} ${e}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SETTINGS = (uid) => ({
  serverUrl: "ws://fake", serverPassword: "", serverSecret: "",
  displayName: uid, cursorColor: "", uid, ntfyTopic: "", debugLogging: false, diagnosticLogging: false, clientTelemetry: false, shares: [],
});

/** A "client": a fake App + an EchoGuard + a FileProvider for one file, with the
 *  SyncManager glue (vault modify → echo-check → applyLocalChange) wired in. */
async function makeClient(uid, room, filePath, initialDisk) {
  const app = new App();
  const echo = new EchoGuard();
  await app.vault.create(filePath, initialDisk);
  const modifyCounts = { n: 0 };
  app.vault.on("modify", async (file) => {
    if (file.path !== filePath) return;
    modifyCounts.n++;
    const content = await app.vault.read(file);
    if (echo.isEcho(file.path, content)) return; // mirrors SyncManager.onFileModify
    fp.applyLocalChange(content);
  });
  const fp = new FileProvider({
    app, settings: SETTINGS(uid), filePath, roomName: room, shareId: "test",
    token: "t", authParams: {}, echo,
    onStatusChange: () => {}, onUsersChange: () => {}, onLocalEdit: () => {}, onPending: () => {},
  });
  await fp.start(initialDisk);
  const obj = { app, echo, fp, filePath, modifyCounts, uid,
    disk: () => app.vault.content.get(filePath),
    edit: async (content) => { const f = app.vault.getAbstractFileByPath(filePath); await app.vault.modify(f, content); },
  };
  return obj;
}

console.log("integration test (real FileProvider over fake transport)\n");

// ── 1. Two clients converge on content ────────────────────────────────────────
console.log("Two clients: remote content reaches the peer's disk");
{
  __resetIdb(); __resetHubs();
  const room = "@test:file:note";
  const A = await makeClient("A", room, "note.md", "hello world");
  const B = await makeClient("B", room, "note.md", "");
  await sleep(900); // FileProvider onSynced has a 500ms gate
  check("B's disk received A's content", B.disk() === "hello world", `B="${B.disk()}"`);
  check("A's disk unchanged", A.disk() === "hello world");
  A.fp.destroy(); B.fp.destroy();
}

// ── 1b. Joining with a local copy must not insert a second whole-file copy ────
console.log("Joining with a matching local copy does not duplicate the note");
{
  __resetIdb(); __resetHubs();
  const room = "@test:file:note-copy";
  const A = await makeClient("A", room, "note.md", "hello world");
  await sleep(900);
  const B = await makeClient("B", room, "note.md", "hello world");
  await sleep(900);
  check("A stayed single-copy", A.disk() === "hello world", `A="${A.disk()}"`);
  check("B stayed single-copy", B.disk() === "hello world", `B="${B.disk()}"`);
  check("A and B converged without duplication", A.disk() === B.disk(), `A="${A.disk()}" B="${B.disk()}"`);
  A.fp.destroy(); B.fp.destroy();
}

// ── 1c. Canvas files use the same text-sync path ──────────────────────────────
console.log("Canvas JSON files sync over the text provider");
{
  __resetIdb(); __resetHubs();
  const room = "@test:file:board.canvas";
  const canvas = JSON.stringify({ nodes: [{ id: "a", type: "text", text: "Idea" }], edges: [] }, null, 2);
  const A = await makeClient("A", room, "board.canvas", canvas);
  const B = await makeClient("B", room, "board.canvas", "");
  await sleep(900);
  check("B's canvas received A's JSON", B.disk() === canvas, `B="${B.disk()}"`);
  await A.edit(canvas.replace("Idea", "Updated idea"));
  await sleep(900);
  check("canvas update converges", B.disk().includes("Updated idea"), `B="${B.disk()}"`);
  A.fp.destroy(); B.fp.destroy();
}

// ── 2. Bidirectional edits converge (CRDT) ────────────────────────────────────
console.log("Bidirectional edits converge");
{
  __resetIdb(); __resetHubs();
  const room = "@test:file:note2";
  const A = await makeClient("A", room, "note.md", "base\n");
  const B = await makeClient("B", room, "note.md", "");
  await sleep(900);
  await A.edit("base\nA-line\n");
  await sleep(400);
  await B.edit(B.disk().replace("base\n", "base\nB-line\n"));
  await sleep(900);
  check("A and B disks converge", A.disk() === B.disk(), `A="${A.disk()}" B="${B.disk()}"`);
  check("A's edit present", A.disk().includes("A-line"));
  check("B's edit present", A.disk().includes("B-line"));
  A.fp.destroy(); B.fp.destroy();
}

// ── 3. No feedback loop: a remote change doesn't trigger runaway disk writes ───
console.log("No feedback loop on the receiver");
{
  __resetIdb(); __resetHubs();
  const room = "@test:file:note3";
  const A = await makeClient("A", room, "note.md", "x");
  const B = await makeClient("B", room, "note.md", "");
  await sleep(900);
  const before = B.modifyCounts.n;
  for (let i = 0; i < 8; i++) { await A.edit("x" + "y".repeat(i + 1)); await sleep(120); }
  await sleep(900);
  const writes = B.modifyCounts.n - before;
  check("B converged to A", B.disk() === A.disk(), `B="${B.disk()}" A="${A.disk()}"`);
  check("B disk-writes bounded (no runaway)", writes <= 30, `writes=${writes}`);
  A.fp.destroy(); B.fp.destroy();
}

// ── 4. Offline edit reconciles on reconnect (no loss) ─────────────────────────
console.log("Offline edit reconciles on reconnect");
{
  __resetIdb(); __resetHubs();
  const room = "@test:file:note4";
  const A = await makeClient("A", room, "note.md", "shared\n");
  const B = await makeClient("B", room, "note.md", "");
  await sleep(900);
  // B goes offline and edits its disk; A edits a different line meanwhile.
  B.fp.getProvider().disconnect();
  await sleep(50);
  await B.edit("shared\nB-offline\n");
  await A.edit("A-top\nshared\n");
  await sleep(400);
  // B reconnects → both edits should survive the merge.
  B.fp.getProvider().connect();
  await sleep(1000);
  check("A and B converge after reconnect", A.disk() === B.disk(), `A="${A.disk()}" B="${B.disk()}"`);
  check("B's offline edit survived", A.disk().includes("B-offline"), `A="${A.disk()}"`);
  check("A's concurrent edit survived", A.disk().includes("A-top"), `A="${A.disk()}"`);
  A.fp.destroy(); B.fp.destroy();
}

// ── 4b. Editor-owned yCollab transactions still project to disk ──────────────
console.log("Editor-bound transactions flush to disk");
{
  __resetIdb(); __resetHubs();
  const room = "@test:file:note5";
  const A = await makeClient("A", room, "note.md", "base");
  await sleep(900);

  await A.fp.setEditorBound(true);
  A.fp.getDoc().transact(() => {
    A.fp.getYText().insert(A.fp.getYText().length, "\nwhile-bound");
  }, "test-editor");
  await sleep(450);
  check("bound editor transaction projected to disk", A.disk().includes("while-bound"), `disk="${A.disk()}"`);

  A.fp.getDoc().transact(() => {
    A.fp.getYText().insert(A.fp.getYText().length, "\non-switch");
  }, "test-editor");
  await A.fp.setEditorBound(false);
  check("unbind awaited the final flush", A.disk().includes("on-switch"), `disk="${A.disk()}"`);
  A.fp.destroy();
}

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else { console.log("ALL PASSED"); process.exit(0); }
