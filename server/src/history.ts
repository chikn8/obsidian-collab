import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";

const exec = promisify(execFile);

const PERSIST_DIR = process.env.PERSIST_DIR || "./collab-data";
const SNAPSHOT_DIR = path.join(PERSIST_DIR, "snapshots");

export interface Version {
  hash: string;
  author: string;
  date: string; // ISO
  subject: string;
}

/** Snapshot path for a share+relPath — mirrors snapshots.ts (legacy at root). */
function snapRel(shareId: string, relPath: string): string | null {
  if (shareId.includes("..") || relPath.split("/").includes("..")) return null;
  return shareId === "legacy" ? relPath : path.posix.join(shareId, relPath);
}

/** Commit history for one file (newest first). Empty array if untracked. */
export async function listVersions(shareId: string, relPath: string, limit = 50): Promise<Version[]> {
  const rel = snapRel(shareId, relPath);
  if (!rel) return [];
  try {
    const { stdout } = await exec(
      "git",
      ["log", "--follow", `-n${Math.min(limit, 200)}`, "--format=%H%x1f%an%x1f%aI%x1f%s", "--", rel],
      { cwd: SNAPSHOT_DIR, maxBuffer: 4 * 1024 * 1024 }
    );
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, author, date, subject] = line.split("\x1f");
        return { hash, author, date, subject };
      });
  } catch {
    return [];
  }
}

export interface ShareFile {
  path: string; // share-relative path
  date: string; // ISO of last snapshot commit
  author: string;
}

const SHARE_ID_RE = /^[1-9A-HJ-NP-Za-km-z]{16,}$/; // namespaced share ids (base58)

/**
 * Every file we hold git snapshots for in a share. The server is content-
 * agnostic and can't know which are deleted — the client cross-references this
 * against its manifest tombstones to surface recoverable "Deleted files". The
 * server never removes snapshot files, so a deleted file's last content stays
 * in HEAD and is restorable via getVersion. Additive: old clients ignore it.
 */
export async function listShareFiles(shareId: string, limit = 1000): Promise<ShareFile[]> {
  if (shareId.includes("..") || shareId.includes("/")) return [];
  const namespaced = shareId !== "legacy";
  const pathspec = namespaced ? `${shareId}/` : ".";
  try {
    const { stdout } = await exec("git", ["ls-files", "-z", "--", pathspec], {
      cwd: SNAPSHOT_DIR,
      maxBuffer: 8 * 1024 * 1024,
    });
    const tracked = stdout.split("\0").filter(Boolean).slice(0, limit);
    const out: ShareFile[] = [];
    for (const full of tracked) {
      let rel: string;
      if (namespaced) {
        rel = full.slice(shareId.length + 1); // strip "<shareId>/"
      } else {
        // Legacy snapshots live at the repo root; skip namespaced share dirs.
        const top = full.split("/")[0];
        if (SHARE_ID_RE.test(top)) continue;
        rel = full;
      }
      if (!rel) continue;
      // Last commit that touched this file (newest), for display.
      let date = "";
      let author = "";
      try {
        const { stdout: meta } = await exec(
          "git",
          ["log", "-1", "--format=%aI%x1f%an", "--", full],
          { cwd: SNAPSHOT_DIR, maxBuffer: 1024 * 1024 }
        );
        [date, author] = meta.trim().split("\x1f");
      } catch {
        /* leave blank */
      }
      out.push({ path: rel, date: date || "", author: author || "" });
    }
    return out;
  } catch {
    return [];
  }
}

/** Text content of a file at a specific commit, or null. */
export async function getVersion(shareId: string, relPath: string, hash: string): Promise<string | null> {
  const rel = snapRel(shareId, relPath);
  if (!rel) return null;
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) return null; // hash sanity (no injection via pathspec)
  try {
    const { stdout } = await exec("git", ["show", `${hash}:${rel}`], {
      cwd: SNAPSHOT_DIR,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}
