import { logEvent } from "../src/logging.ts";

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

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
