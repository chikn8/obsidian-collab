#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const requirements = [
  {
    id: "diagnostics-logging",
    title: "Verbose diagnostics for feedback loops and glitches",
    checks: [
      exists("plugin/src/utils/log.ts"),
      contains("plugin/src/utils/log.ts", "exportDiagnosticBundle"),
      contains("plugin/src/utils/log.ts", "clientTelemetry"),
      exists("tools/diagnostics-summary.mjs"),
      contains("server/src/logging.ts", "getLogDrainHealth"),
      contains("server/src/audit.ts", "auditEvent"),
      exists("plugin/test/diagnostics.test.mjs"),
      exists("server/test/logging.test.mjs"),
      exists("server/test/client-log.test.mjs"),
    ],
  },
  {
    id: "ai-regression",
    title: "AI-runnable regression and readiness gates",
    checks: [
      exists("tools/ai-regression.mjs"),
      contains("tools/ai-regression.mjs", "server-e2e"),
      exists("tools/release-readiness.mjs"),
      contains("tools/release-readiness.mjs", "manualGates"),
      exists("tools/prod-health-check.mjs"),
      contains(".github/workflows/release-plugin.yml", "Release readiness"),
    ],
  },
  {
    id: "presence-surfaces",
    title: "Presence in editor, file tree, and tab headers",
    checks: [
      exists("plugin/src/collab/Presence.ts"),
      exists("plugin/src/collab/PresenceDom.ts"),
      contains("plugin/src/collab/SyncManager.ts", "renderFileTreePresence"),
      contains("plugin/src/collab/SyncManager.ts", "renderTabPresence"),
      contains("plugin/src/collab/SyncManager.ts", "schedulePresenceAnchorRetry"),
      contains("plugin/styles.css", ".collab-file-presence-host"),
      contains("plugin/styles.css", ".collab-tab-presence-host"),
      exists("plugin/test/presence-dom.test.mjs"),
    ],
  },
  {
    id: "typing-indicator",
    title: "Custom typing pill on avatars",
    checks: [
      contains("plugin/src/collab/PresenceDom.ts", "makeTypingDots"),
      contains("plugin/src/collab/Presence.ts", "makeTypingDots"),
      contains("plugin/styles.css", ".collab-typing-pill"),
      contains("plugin/test/presence-dom.test.mjs", "typing pill has three dots"),
    ],
  },
  {
    id: "self-visible-cursor-selection",
    title: "Self-visible cursor and selection overlays",
    checks: [
      exists("plugin/src/collab/SelfSelection.ts"),
      contains("plugin/src/collab/SelfSelection.ts", "cm-collab-self-caret"),
      contains("plugin/src/main.ts", "selfSelectionExtension"),
      exists("plugin/test/self-selection.test.mjs"),
      contains("docs/RELEASES_AND_MOBILE.md", "self-selection overlay"),
    ],
  },
  {
    id: "save-on-switch",
    title: "Active editor changes flush on switch/lifecycle",
    checks: [
      contains("plugin/src/collab/FileProvider.ts", "flushToDisk"),
      contains("plugin/src/collab/FileProvider.ts", "editor-bound-write-deferred"),
      contains("plugin/src/collab/FileProvider.ts", "flushToDisk(\"editor-unbound\")"),
      contains("plugin/src/main.ts", "flushActiveEditorForLifecycle"),
      contains("plugin/src/main.ts", "active-leaf-change"),
      contains("plugin/test/integration.test.mjs", "bound editor transaction does not external-write mid-typing"),
      contains("plugin/test/integration.test.mjs", "unbind awaited the final flush"),
      contains("plugin/test/integration.test.mjs", "lifecycle flush projects bound editor immediately"),
    ],
  },
  {
    id: "event-driven-sync",
    title: "Action/event-driven sync foundations",
    checks: [
      contains("plugin/src/main.ts", "vault.on(\"create\""),
      contains("plugin/src/main.ts", "vault.on(\"modify\""),
      contains("plugin/src/main.ts", "vault.on(\"delete\""),
      contains("plugin/src/main.ts", "vault.on(\"rename\""),
      contains("plugin/src/collab/EditorBinding.ts", "yCollab"),
      contains("plugin/src/collab/EchoGuard.ts", "fingerprint"),
      contains("plugin/test/loop-sim.test.mjs", "stale-echo"),
    ],
  },
  {
    id: "multi-device-identity",
    title: "Multi-device presence and invite limits",
    checks: [
      contains("plugin/src/collab/PresenceModel.ts", "deviceId"),
      contains("plugin/test/presence.test.mjs", "same person can appear as two devices"),
      contains("server/src/shareState.ts", "maxDevices"),
      contains("server/test/share-state.test.mjs", "multi-device invite accepts configured second identity"),
      contains("server/test/ws-e2e.test.mjs", "configured device limit"),
      contains("plugin/src/ui/SettingsTab.ts", "Max devices"),
    ],
  },
  {
    id: "folder-repoint",
    title: "Move/repoint shares and keep sibling shares separate",
    checks: [
      exists("plugin/src/utils/shareFolders.ts"),
      contains("plugin/src/ui/SettingsTab.ts", "Change folder"),
      contains("plugin/src/main.ts", "changeShareLocalFolderInteractive"),
      exists("plugin/test/share-folders.test.mjs"),
      contains("README.md", "Move/repoint a local share"),
    ],
  },
  {
    id: "roles-security-invites",
    title: "Server-side roles, per-share keys, invites, and security docs",
    checks: [
      contains("server/src/auth.ts", "verifyInviteAccess"),
      contains("server/src/index.ts", "/share/invite"),
      contains("server/src/index.ts", "SHARE_MINT_TOKEN"),
      contains("server/src/rooms.ts", "viewer"),
      contains("server/test/auth.test.mjs", "invite token is invite scoped"),
      contains("server/test/ws-e2e.test.mjs", "Viewer writes are rejected"),
      contains("README.md", "Security model at a glance"),
      contains("docs/ARCHITECTURE.md", "Auth, roles, revocation"),
    ],
  },
  {
    id: "mobile-release-updates",
    title: "Mobile support and release/update path",
    checks: [
      jsonEquals("plugin/manifest.json", "isDesktopOnly", false),
      exists("docs/MOBILE_TEST_MATRIX.md"),
      exists("docs/mobile-test-result.example.json"),
      exists("tools/mobile-matrix-check.mjs"),
      contains("tools/release-readiness.mjs", "--mobile-result="),
      contains("docs/RELEASES_AND_MOBILE.md", "BRAT"),
      contains("docs/RELEASES_AND_MOBILE.md", "Community Plugin"),
      contains(".github/workflows/release-plugin.yml", "gh release create"),
      exists("plugin/test/release-metadata.test.mjs"),
    ],
  },
  {
    id: "ops-durability",
    title: "Production durability, backups, and alert gates",
    checks: [
      contains("server/src/health.ts", "collectServerHealth"),
      contains("server/src/backups.ts", "PERSIST_BACKUP_COMMAND"),
      contains("server/src/snapshots.ts", "SNAPSHOT_GIT_REMOTE"),
      contains("server/src/notify.ts", "getOpsAlertHealth"),
      contains("tools/prod-health-check.mjs", "OPS_NTFY_TOPIC"),
      contains("server/test/health-monitor.test.mjs", "opsAlerts"),
    ],
  },
];

let failures = 0;
console.log("requirements audit\n");
for (const req of requirements) {
  const failed = [];
  for (const check of req.checks) {
    const result = check();
    if (!result.ok) failed.push(result.message);
  }
  if (failed.length === 0) {
    console.log(`  ✓ ${req.id} - ${req.title}`);
  } else {
    failures++;
    console.error(`  ✗ ${req.id} - ${req.title}`);
    for (const item of failed) console.error(`    - ${item}`);
  }
}

console.log("");
if (failures > 0) {
  console.error(`FAILED - ${failures} requirement group(s) missing evidence`);
  process.exit(1);
}
console.log("ALL PASSED");

function exists(relPath) {
  return () => ({
    ok: fs.existsSync(abs(relPath)),
    message: `${relPath} does not exist`,
  });
}

function contains(relPath, needle) {
  return () => {
    const file = abs(relPath);
    if (!fs.existsSync(file)) return { ok: false, message: `${relPath} does not exist` };
    const body = fs.readFileSync(file, "utf8");
    return {
      ok: body.includes(needle),
      message: `${relPath} does not contain ${JSON.stringify(needle)}`,
    };
  };
}

function jsonEquals(relPath, key, expected) {
  return () => {
    const file = abs(relPath);
    if (!fs.existsSync(file)) return { ok: false, message: `${relPath} does not exist` };
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      ok: parsed?.[key] === expected,
      message: `${relPath}.${key} is ${JSON.stringify(parsed?.[key])}, expected ${JSON.stringify(expected)}`,
    };
  };
}

function abs(relPath) {
  return path.join(root, relPath);
}
