import fs from "fs/promises";
import os from "os";
import path from "path";

let cachedKey = "";
let cachedDir = "";
let cachedCommand = "";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function normalizedPrivateKey(): string {
  const raw = process.env.SNAPSHOT_GIT_SSH_KEY || "";
  if (!raw.trim()) return "";
  const normalized = raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

async function materializeKey(privateKey: string): Promise<string> {
  const dir = process.env.SNAPSHOT_GIT_SSH_KEY_DIR || path.join(os.tmpdir(), "obsidian-collab-git-ssh");
  if (cachedCommand && cachedKey === privateKey && cachedDir === dir) return cachedCommand;

  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => undefined);

  const keyPath = path.join(dir, "snapshot_git_ssh_key");
  const knownHostsPath = path.join(dir, "known_hosts");
  await fs.writeFile(keyPath, privateKey, { mode: 0o600 });
  await fs.chmod(keyPath, 0o600).catch(() => undefined);

  cachedKey = privateKey;
  cachedDir = dir;
  cachedCommand = [
    "ssh",
    "-i", shellQuote(keyPath),
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${shellQuote(knownHostsPath)}`,
  ].join(" ");
  return cachedCommand;
}

export async function gitCommandEnv(baseEnv: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    GIT_TERMINAL_PROMPT: baseEnv.GIT_TERMINAL_PROMPT || "0",
  };
  const privateKey = normalizedPrivateKey();
  if (privateKey) env.GIT_SSH_COMMAND = await materializeKey(privateKey);
  return env;
}
