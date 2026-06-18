import { clientLogFields } from "../src/clientLog.ts";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

console.log("server client log\n");

const fields = clientLogFields({
  shareId: "share-1",
  role: "editor",
  remote: "127.0.0.1",
  body: {
    row: {
      sessionId: "session-1",
      seq: 7,
      ts: "2026-06-18T00:00:00.000Z",
      dt: 1234,
      level: "error",
      ns: "share",
      event: "error",
      fields: {
        token: "should-not-export",
        noteText: "should-not-export",
        path: "Shared/note.md",
        args: [
          "server mint failed",
          { name: "Error", message: "boom", stack: "stack line" },
        ],
      },
    },
    context: {
      settings: {
        serverToken: "should-not-export",
        shareCount: 2,
      },
      runtime: {
        boundPath: "Shared/note.md",
      },
    },
  },
});

check("keeps authenticated server metadata", fields.shareId === "share-1" && fields.role === "editor" && fields.remote === "127.0.0.1");
check("keeps client row identity", fields.client?.sessionId === "session-1" && fields.client?.seq === 7 && fields.client?.ns === "share");
check("redacts client token fields", fields.clientFields?.token === "[redacted]");
check("redacts client text fields", fields.clientFields?.noteText === "[redacted]");
check("keeps safe client fields", fields.clientFields?.path === "Shared/note.md" && fields.clientFields?.args?.[0] === "server mint failed");
check("redacts context secrets", fields.clientContext?.settings?.serverToken === "[redacted]");
check("keeps safe context", fields.clientContext?.settings?.shareCount === 2 && fields.clientContext?.runtime?.boundPath === "Shared/note.md");
check("does not leak secret values", !JSON.stringify(fields).includes("should-not-export"));

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
