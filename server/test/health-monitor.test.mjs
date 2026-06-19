import {
  checkHealthOnce,
  degradedHealthComponents,
  healthAlertBody,
} from "../src/healthMonitor.ts";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

console.log("server health monitor\n");

const degradedHealth = {
  status: "degraded",
  persistence: { ok: true },
  snapshots: { ok: false, lastPushError: "remote missing" },
  shareState: { ok: true },
  backups: { ok: false, lastBackupError: "rclone failed" },
  blobs: { ok: true },
  runtime: { ok: true },
  logDrain: { ok: true },
  opsAlerts: { ok: false, configured: false, required: true },
};

const components = degradedHealthComponents(degradedHealth);
check("finds degraded health components", components.join(",") === "snapshots,backups,opsAlerts", components.join(","));
const body = healthAlertBody(degradedHealth, components);
check("alert body summarizes status", body.includes("status=degraded") && body.includes("degraded=snapshots,backups,opsAlerts"), body);
check("alert body includes component reasons", body.includes("remote missing") && body.includes("rclone failed") && body.includes("required but not configured"), body);

{
  const sent = [];
  const ok = await checkHealthOnce(
    async () => ({ status: "ok", persistence: { ok: true }, snapshots: { ok: true } }),
    async (...args) => { sent.push(args); }
  );
  check("healthy check does not alert", ok === true && sent.length === 0, JSON.stringify(sent));
}

{
  const sent = [];
  const ok = await checkHealthOnce(
    async () => degradedHealth,
    async (...args) => { sent.push(args); }
  );
  check("degraded check alerts", ok === false && sent[0]?.[0] === "health-degraded", JSON.stringify(sent));
  check("degraded alert includes body", sent[0]?.[2]?.includes("snapshots"), JSON.stringify(sent));
}

{
  const sent = [];
  const originalError = console.error;
  try {
    console.error = () => {};
    const ok = await checkHealthOnce(
      async () => { throw new Error("health exploded"); },
      async (...args) => { sent.push(args); }
    );
    check("failed check alerts", ok === false && sent[0]?.[0] === "health-check-failed", JSON.stringify(sent));
    check("failed alert includes error", sent[0]?.[2] === "health exploded", JSON.stringify(sent));
  } finally {
    console.error = originalError;
  }
}

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
