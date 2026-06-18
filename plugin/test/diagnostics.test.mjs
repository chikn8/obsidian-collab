import {
  configureDiagnostics,
  exportDiagnosticBundle,
  getRecentDiagnostics,
  trace,
} from "../src/utils/log.ts";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

console.log("diagnostics\n");

const writes = new Map();
const app = {
  vault: {
    configDir: ".mobile-config",
    adapter: {
      async mkdir(_path) {},
      async write(path, body) { writes.set(path, body); },
    },
  },
};

configureDiagnostics({
  app,
  uid: "user-123456789",
  debugLogging: false,
  diagnosticLogging: false,
  context: () => ({
    plugin: { version: "0.1-test" },
    settings: { shareCount: 2, serverToken: "should-not-export" },
    runtime: { boundPath: "Shared/note.md" },
  }),
});
trace("test", "redaction", {
  token: "should-not-export",
  serverSecret: "should-not-export",
  content: "note text should not export",
  body: "message body should not export",
  path: "Shared/note.md",
  len: 27,
});

const last = getRecentDiagnostics().at(-1);
check("records structured rows", !!last && last.ns === "test" && last.event === "redaction");
check("redacts token fields", last?.fields?.token === "[redacted]");
check("redacts content fields", last?.fields?.content === "[redacted]" && last?.fields?.body === "[redacted]");
check("keeps safe metadata", last?.fields?.path === "Shared/note.md" && last?.fields?.len === 27);

const bundlePath = await exportDiagnosticBundle();
const bundle = JSON.parse(writes.get(bundlePath));
check("exports under vault config dir", bundlePath.startsWith(".mobile-config/plugins/obsidian-collab/diagnostics/"), bundlePath);
check("writes bundle file", writes.has(bundlePath));
check("bundle includes sanitized context", bundle.context.plugin.version === "0.1-test" && bundle.context.settings.shareCount === 2);
check("bundle context redacts secret-like fields", bundle.context.settings.serverToken === "[redacted]");
check("bundle includes diagnostics state", bundle.context.diagnostics.rowCount >= 1 && typeof bundle.context.diagnostics.tracePath === "string");
check("bundle excludes secret values", !writes.get(bundlePath).includes("should-not-export"));

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
