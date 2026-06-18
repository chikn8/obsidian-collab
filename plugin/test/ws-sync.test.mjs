/**
 * Server end-to-end sync harness (MANUAL — needs a running server; not part of
 * `npm test`).
 *
 * IMPORTANT: per the handoff note, multiple y-websocket clients in ONE Node
 * process cross-talk. So writer and reader run as SEPARATE processes and this
 * script orchestrates them via child_process. Verifies the server relays +
 * persists a Y.Text edit across a disconnect.
 *
 *   node test/ws-sync.test.mjs [wsBase] [token]
 *   e.g. node test/ws-sync.test.mjs wss://<railway-host> <auth-token>
 *
 * Default targets a local server on ws://127.0.0.1:18234 with token "testauth".
 */
import { fork } from "child_process";
import { fileURLToPath } from "url";

const BASE = process.argv[2] || "ws://127.0.0.1:18234";
const TOKEN = process.argv[3] || "testauth";
const ROLE = process.env.WS_ROLE;
const ROOM = process.env.WS_ROOM || `test-sync-${Math.floor(Date.now() / 1000)}`;
const self = fileURLToPath(import.meta.url);

// ── child mode: run one client (writer or reader) ─────────────────────────────
if (ROLE) {
  const Y = await import("yjs");
  const { WebsocketProvider } = await import("y-websocket");
  const WS = (await import("ws")).default;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const doc = new Y.Doc();
  const p = new WebsocketProvider(BASE, ROOM, doc, { params: { token: TOKEN }, WebSocketPolyfill: WS, connect: true });
  await new Promise((res) => { if (p.synced) res(); p.on("sync", (s) => { if (s) res(); }); });
  if (ROLE === "writer") {
    doc.getText("codemirror").insert(0, "ws-harness hello");
    await sleep(1500);
  } else {
    await sleep(700);
    process.stdout.write("READER_TEXT:" + JSON.stringify(doc.getText("codemirror").toString()) + "\n");
  }
  p.disconnect();
  await sleep(200);
  process.exit(0);
}

// ── parent mode: orchestrate writer then reader as separate processes ─────────
function run(role) {
  return new Promise((resolve) => {
    let out = "";
    const child = fork(self, [BASE, TOKEN], { env: { ...process.env, WS_ROLE: role, WS_ROOM: ROOM }, stdio: ["ignore", "pipe", "inherit", "ipc"] });
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.on("exit", () => resolve(out));
  });
}

console.log(`ws-sync harness → ${BASE} room=${ROOM}`);
await run("writer");
await new Promise((r) => setTimeout(r, 1000));
const readerOut = await run("reader");
const m = readerOut.match(/READER_TEXT:(.*)/);
const text = m ? JSON.parse(m[1]) : "";
if (text === "ws-harness hello") {
  console.log("  ✓ reader received persisted text");
  console.log("\nALL PASSED");
  process.exit(0);
} else {
  console.error(`  ✗ reader got ${JSON.stringify(text)}`);
  console.error("\nFAILED");
  process.exit(1);
}
