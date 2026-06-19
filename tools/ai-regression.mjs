#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const quick = args.has("--quick");
const quiet = args.has("--quiet");
const reportArg = process.argv.slice(2).find((arg) => arg.startsWith("--report="));
const reportPath = path.resolve(root, reportArg ? reportArg.slice("--report=".length) : "tools/ai-regression-report.json");

const steps = [
  { id: "plugin-test", cwd: "plugin", cmd: "npm", args: ["test"] },
  { id: "plugin-build", cwd: "plugin", cmd: "npm", args: ["run", "build"] },
  { id: "server-test", cwd: "server", cmd: "npm", args: ["test"] },
  { id: "server-build", cwd: "server", cmd: "npm", args: ["run", "build"] },
  ...(quick ? [] : [{ id: "server-e2e", cwd: "server", cmd: "npm", args: ["run", "test:e2e"] }]),
  { id: "diagnostics-summary", cwd: ".", cmd: "node", args: ["tools/diagnostics-summary.test.mjs"] },
  { id: "requirements-audit", cwd: ".", cmd: "node", args: ["tools/requirements-audit.mjs"] },
  { id: "diff-check", cwd: ".", cmd: "git", args: ["diff", "--check"] },
];

const startedAt = new Date();
const results = [];

for (const step of steps) {
  const result = await runStep(step);
  results.push(result);
  if (result.exitCode !== 0) break;
}

const endedAt = new Date();
const ok = results.length === steps.length && results.every((r) => r.exitCode === 0);
const report = {
  ok,
  quick,
  startedAt: startedAt.toISOString(),
  endedAt: endedAt.toISOString(),
  durationMs: endedAt.getTime() - startedAt.getTime(),
  steps: results,
};

await fs.mkdir(path.dirname(reportPath), { recursive: true });
await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");

console.log("");
console.log(`AI regression ${ok ? "PASSED" : "FAILED"} (${report.durationMs}ms)`);
console.log(`Report: ${path.relative(root, reportPath)}`);
for (const result of results) {
  console.log(`- ${result.id}: ${result.exitCode === 0 ? "ok" : `exit ${result.exitCode}`} (${result.durationMs}ms)`);
}

process.exit(ok ? 0 : 1);

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
