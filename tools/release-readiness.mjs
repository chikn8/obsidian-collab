#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const quick = argv.includes("--quick");
const quiet = argv.includes("--quiet");
const runProd = argv.includes("--prod");
const allowDirty = argv.includes("--allow-dirty");
const reportArg = argv.find((arg) => arg.startsWith("--report="));
const healthArg = argv.find((arg) => arg.startsWith("--health-url="));
const mobileResultArg = argv.find((arg) => arg.startsWith("--mobile-result="));
const reportPath = path.resolve(
  root,
  reportArg ? reportArg.slice("--report=".length) : path.join(os.tmpdir(), "obsidian-collab-release-readiness.json")
);
const healthUrl = healthArg ? healthArg.slice("--health-url=".length) : "https://obsidiansync-production.up.railway.app/health";
const mobileResultPath = mobileResultArg ? mobileResultArg.slice("--mobile-result=".length) : "";

const startedAt = new Date();
const steps = [];

steps.push(await runStep({
  id: "ai-regression",
  cwd: ".",
  cmd: process.execPath,
  args: [
    "tools/ai-regression.mjs",
    "--quiet",
    ...(quick ? ["--quick"] : []),
    `--report=${path.join(os.tmpdir(), "obsidian-collab-ai-regression-readiness.json")}`,
  ],
}));

steps.push(await checkCleanWorktree());

if (runProd) {
  steps.push(await runStep({
    id: "prod-health",
    cwd: ".",
    cmd: process.execPath,
    args: ["tools/prod-health-check.mjs", healthUrl],
  }));
}

if (mobileResultPath) {
  steps.push(await runStep({
    id: "mobile-matrix",
    cwd: ".",
    cmd: process.execPath,
    args: ["tools/mobile-matrix-check.mjs", mobileResultPath],
  }));
}

const manualGates = [
  {
    id: "mobile-device-matrix",
    status: mobileResultPath ? "covered-by-mobile-result" : "manual",
    detail: mobileResultPath
      ? `Validated ${mobileResultPath}.`
      : "Run docs/MOBILE_TEST_MATRIX.md with one desktop + one phone peer, covering foreground/background, attachment sync, comments, and conflict recovery. Then pass --mobile-result=<result.json>.",
  },
  {
    id: "railway-volume",
    status: runProd ? "covered-by-prod-health" : "manual",
    detail: runProd
      ? "Production /health checked persistence plus required off-box backup configuration."
      : "Run with --prod after Railway volume, SNAPSHOT_GIT_REMOTE, PERSIST_BACKUP_COMMAND, and OPS_NTFY_TOPIC are configured.",
  },
];

const endedAt = new Date();
const automatedOk = steps.every((step) => step.exitCode === 0);
const report = {
  ok: automatedOk,
  quick,
  prod: runProd,
  mobileResult: mobileResultPath || null,
  startedAt: startedAt.toISOString(),
  endedAt: endedAt.toISOString(),
  durationMs: endedAt.getTime() - startedAt.getTime(),
  steps,
  manualGates,
};

await fs.mkdir(path.dirname(reportPath), { recursive: true });
await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");

console.log("");
console.log(`Release readiness ${automatedOk ? "PASSED" : "FAILED"} (${report.durationMs}ms)`);
console.log(`Report: ${path.relative(root, reportPath)}`);
for (const step of steps) {
  console.log(`- ${step.id}: ${step.exitCode === 0 ? "ok" : `exit ${step.exitCode}`} (${step.durationMs}ms)`);
}
for (const gate of manualGates) {
  console.log(`- ${gate.id}: ${gate.status}`);
  console.log(`  ${gate.detail}`);
}

process.exit(automatedOk ? 0 : 1);

async function checkCleanWorktree() {
  const result = await runStep({
    id: "clean-worktree",
    cwd: ".",
    cmd: "git",
    args: ["status", "--porcelain"],
  });
  if (allowDirty) return { ...result, exitCode: 0, note: "dirty worktree allowed by --allow-dirty" };
  if (result.exitCode !== 0) return result;
  if (result.stdoutTail.trim()) {
    return {
      ...result,
      exitCode: 1,
      stderrTail: "Worktree has uncommitted changes:\n" + result.stdoutTail,
    };
  }
  return result;
}

function runStep(step) {
  return new Promise((resolve) => {
    const started = Date.now();
    if (!quiet) {
      console.log("");
      console.log(`==> ${step.id}: ${step.cmd} ${step.args.join(" ")}`);
    }
    const child = spawn(step.cmd, step.args, {
      cwd: path.resolve(root, step.cwd),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      if (!quiet) process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      if (!quiet) process.stderr.write(text);
    });
    child.on("close", (code, signal) => {
      resolve({
        id: step.id,
        command: [step.cmd, ...step.args].join(" "),
        cwd: step.cwd,
        exitCode: code ?? 1,
        signal,
        durationMs: Date.now() - started,
        stdoutTail: tail(stdout),
        stderrTail: tail(stderr),
      });
    });
    child.on("error", (error) => {
      resolve({
        id: step.id,
        command: [step.cmd, ...step.args].join(" "),
        cwd: step.cwd,
        exitCode: 1,
        signal: null,
        durationMs: Date.now() - started,
        stdoutTail: tail(stdout),
        stderrTail: tail(`${stderr}\n${error.stack || error.message}`),
      });
    });
  });
}

function tail(text, max = 12000) {
  if (text.length <= max) return text;
  return text.slice(text.length - max);
}
