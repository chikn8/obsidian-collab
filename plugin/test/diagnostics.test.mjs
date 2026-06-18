import {
  configureDiagnostics,
  err,
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
check("adds sequence and relative timing", Number.isInteger(last?.seq) && last.seq > 0 && Number.isInteger(last?.dt) && last.dt >= 0);
check("redacts token fields", last?.fields?.token === "[redacted]");
check("redacts content fields", last?.fields?.content === "[redacted]" && last?.fields?.body === "[redacted]");
check("keeps safe metadata", last?.fields?.path === "Shared/note.md" && last?.fields?.len === 27);

const bundlePath = await exportDiagnosticBundle();
const bundle = JSON.parse(writes.get(bundlePath));
check("exports under vault config dir", bundlePath.startsWith(".mobile-config/plugins/live-collab/diagnostics/"), bundlePath);
check("writes bundle file", writes.has(bundlePath));
check("bundle includes sanitized context", bundle.context.plugin.version === "0.1-test" && bundle.context.settings.shareCount === 2);
check("bundle context redacts secret-like fields", bundle.context.settings.serverToken === "[redacted]");
check("bundle includes diagnostics state", bundle.context.diagnostics.rowCount >= 1 && typeof bundle.context.diagnostics.tracePath === "string");
check("bundle includes diagnostic capacity counters", bundle.context.diagnostics.maxRows >= 10000 && bundle.context.diagnostics.droppedRows === 0);
check("bundle excludes secret values", !writes.get(bundlePath).includes("should-not-export"));

const posts = [];
const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
try {
  globalThis.fetch = async (url, opts) => {
    posts.push({ url, opts });
    return { ok: true, status: 200 };
  };
  console.error = () => {};
  configureDiagnostics({
    app,
    uid: "user-123456789",
    debugLogging: false,
    diagnosticLogging: false,
    clientTelemetry: { enabled: true, url: "https://relay.example/clientlog?token=should-not-export" },
    context: () => ({
      settings: { serverToken: "should-not-export", shareCount: 1 },
      runtime: { boundPath: "Shared/note.md" },
    }),
  });
  err("telemetry", "provider failed", new Error("boom"));
  await new Promise((resolve) => setTimeout(resolve, 0));
} finally {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
  configureDiagnostics({ clientTelemetry: { enabled: false, url: "" } });
}

const telemetry = posts.length === 1 ? JSON.parse(posts[0].opts.body) : null;
check("posts one telemetry error", posts.length === 1);
check("telemetry uses JSON POST", posts[0]?.opts?.method === "POST" && posts[0]?.opts?.headers?.["Content-Type"] === "application/json");
check("telemetry row is sanitized error", telemetry?.row?.level === "error" && telemetry?.row?.ns === "telemetry");
check("telemetry includes sanitized context", telemetry?.context?.settings?.shareCount === 1 && telemetry?.context?.runtime?.boundPath === "Shared/note.md");
check("telemetry context redacts secrets", telemetry?.context?.settings?.serverToken === "[redacted]");
check("telemetry body excludes secret values", !JSON.stringify(telemetry).includes("should-not-export"));

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
