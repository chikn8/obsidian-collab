import fs from "fs/promises";
import os from "os";
import path from "path";
import { gitCommandEnv } from "../src/gitSsh.ts";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

console.log("server git ssh env\n");

const originalKey = process.env.SNAPSHOT_GIT_SSH_KEY;
const originalDir = process.env.SNAPSHOT_GIT_SSH_KEY_DIR;
try {
  delete process.env.SNAPSHOT_GIT_SSH_KEY;
  delete process.env.SNAPSHOT_GIT_SSH_KEY_DIR;
  let env = await gitCommandEnv({ PATH: "/bin" });
  check("disables interactive git prompts", env.GIT_TERMINAL_PROMPT === "0");
  check("does not set ssh command without key", !env.GIT_SSH_COMMAND);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-collab-git-ssh-test-"));
  process.env.SNAPSHOT_GIT_SSH_KEY_DIR = dir;
  process.env.SNAPSHOT_GIT_SSH_KEY = "-----BEGIN TEST KEY-----\\nabc123\\n-----END TEST KEY-----";

  env = await gitCommandEnv({ PATH: "/bin", GIT_TERMINAL_PROMPT: "1" });
  const keyPath = path.join(dir, "snapshot_git_ssh_key");
  const stat = await fs.stat(keyPath);
  const key = await fs.readFile(keyPath, "utf-8");
  check("preserves caller git prompt setting", env.GIT_TERMINAL_PROMPT === "1");
  check("sets ssh command when key is provided", env.GIT_SSH_COMMAND?.includes(keyPath), env.GIT_SSH_COMMAND);
  check("writes escaped newlines as a real private key file", key.includes("\nabc123\n"));
  check("private key file is owner-only", (stat.mode & 0o777) === 0o600, String((stat.mode & 0o777).toString(8)));
} finally {
  if (originalKey === undefined) delete process.env.SNAPSHOT_GIT_SSH_KEY;
  else process.env.SNAPSHOT_GIT_SSH_KEY = originalKey;
  if (originalDir === undefined) delete process.env.SNAPSHOT_GIT_SSH_KEY_DIR;
  else process.env.SNAPSHOT_GIT_SSH_KEY_DIR = originalDir;
}

console.log("");
if (failures > 0) { console.error(`FAILED - ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
