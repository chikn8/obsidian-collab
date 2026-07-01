import fs from "fs/promises";
import os from "os";
import path from "path";
import { configureLogDrainForTest, getLogDrainHealth, logEvent, readLogDrainTail } from "../src/logging.ts";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

console.log("server logging\n");

const captured = [];
const original = {
  log: console.log,
  warn: console.warn,
  error: console.error,
};

try {
  console.log = (line) => captured.push({ stream: "log", line });
  console.warn = (line) => captured.push({ stream: "warn", line });
  console.error = (line) => captured.push({ stream: "error", line });

  logEvent("info", "test.info", {
    shareId: "share-1",
    token: "should-not-export",
    noteText: "should-not-export",
    beforeTextLen: 123,
    nested: {
      ownerKey: "also-secret",
      ok: true,
    },
    binary: new Uint8Array([1, 2, 3]),
  });
  logEvent("warn", "test.warn", { body: "should-not-export" });
} finally {
  console.log = original.log;
  console.warn = original.warn;
  console.error = original.error;
}

const first = JSON.parse(captured[0]?.line || "{}");
const second = JSON.parse(captured[1]?.line || "{}");

check("emits JSON to level stream", captured[0]?.stream === "log" && captured[1]?.stream === "warn");
check("adds sequence and relative timing", Number.isInteger(first.seq) && first.seq > 0 && Number.isInteger(first.dt) && first.dt >= 0);
check("adds source and pid", first.source === "collab-server" && first.pid === process.pid);
check("records level and event", first.level === "info" && first.event === "test.info");
check("redacts top-level token", first.token === "[redacted]");
check("redacts text fields", first.noteText === "[redacted]");
check("redacts camelCase secret key", first.nested?.ownerKey === "[redacted]");
check("redacts body fields", second.body === "[redacted]");
check("keeps safe length metadata", first.beforeTextLen === 123);
check("summarizes binary payloads", first.binary?.byteLength === 3);
check("does not leak secret values", !captured.map((r) => r.line).join("\n").includes("should-not-export"));

{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-collab-log-"));
  const logPath = path.join(tmp, "server.jsonl");
  const drainCaptured = [];
  configureLogDrainForTest({ enabled: true, path: logPath, maxBytes: 900, rotateCount: 2 });
  try {
    console.log = (line) => drainCaptured.push({ stream: "log", line });
    console.warn = (line) => drainCaptured.push({ stream: "warn", line });
    console.error = (line) => drainCaptured.push({ stream: "error", line });

    logEvent("info", "drain.one", { shareId: "share-1", token: "drain-secret", safe: "yes" });
    logEvent("error", "drain.two", { body: "drain-secret", safe: "still" });
    for (let i = 0; i < 6; i++) {
      logEvent("info", "drain.rotate", { i, message: "x".repeat(260) });
    }
    logEvent("error", "drain.after_rotate_error", { safe: "tail" });
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }

  const current = await fs.readFile(logPath, "utf8");
  const rotated = await fs.readFile(`${logPath}.1`, "utf8");
  const combined = `${current}\n${rotated}`;
  const lines = combined.trim().split(/\n+/).map((line) => JSON.parse(line));
  const health = getLogDrainHealth();
  const warnTail = readLogDrainTail({ level: "error", limit: 5 });
  const eventTail = readLogDrainTail({ event: "drain.rotate", limit: 2 });
  check("retained drain writes JSONL", lines.some((row) => row.event === "drain.rotate"), combined);
  check("retained drain uses level stream", drainCaptured.some((row) => row.stream === "error" && row.line.includes("drain.two")));
  check("retained drain redacts secrets", !combined.includes("drain-secret"), combined);
  check("retained drain rotates when capped", rotated.includes("drain."), rotated);
  check("retained drain health is exposed", health.enabled === true && health.ok === true && health.path === logPath && health.bytes > 0, JSON.stringify(health));
  check("retained drain tail filters level", warnTail.every((row) => row.level === "error") && warnTail.some((row) => row.event === "drain.after_rotate_error"));
  check("retained drain tail filters event", eventTail.length <= 2 && eventTail.every((row) => row.event === "drain.rotate"));
  configureLogDrainForTest({ enabled: false });
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
