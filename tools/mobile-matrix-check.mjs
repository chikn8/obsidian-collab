#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node tools/mobile-matrix-check.mjs <mobile-test-result.json>");
  process.exit(2);
}

const result = JSON.parse(fs.readFileSync(file, "utf8"));
const failures = [];

requireString("pluginVersion");
requireString("serverDeployment");
requireString("desktop.os");
requireString("desktop.obsidianVersion");
requireString("mobile.os");
requireString("mobile.obsidianVersion");
requireString("completedAt");

if (result.passed !== true) failures.push("passed must be true");
if (!Array.isArray(result.failures)) failures.push("failures must be an array");
else if (result.failures.length > 0) failures.push(`failures must be empty (${result.failures.length} recorded)`);
if (!Array.isArray(result.checks) || result.checks.length === 0) {
  failures.push("checks must be a non-empty array of completed checklist ids");
}

const requiredChecks = [
  "setup",
  "text-sync",
  "presence",
  "file-lifecycle",
  "comments-mentions",
  "attachments",
];
for (const check of requiredChecks) {
  if (!result.checks?.includes(check)) failures.push(`checks missing ${check}`);
}

if (Number.isNaN(Date.parse(result.completedAt || ""))) failures.push("completedAt must be an ISO-like date");

console.log(`mobile matrix ${path.relative(process.cwd(), path.resolve(file))}`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log("PASS mobile matrix result accepted");

function requireString(keyPath) {
  const value = get(result, keyPath);
  if (typeof value !== "string" || !value.trim()) failures.push(`${keyPath} must be a non-empty string`);
}

function get(obj, keyPath) {
  return keyPath.split(".").reduce((cur, key) => cur?.[key], obj);
}
