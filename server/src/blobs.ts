import type http from "http";
import { createHash } from "crypto";
import fs from "fs/promises";
import path from "path";
import { atomicWriteFile } from "./storage.js";

const PERSIST_DIR = process.env.PERSIST_DIR || "./collab-data";
const BLOB_DIR = path.join(PERSIST_DIR, "blobs");
export const BLOB_MAX_BYTES = Number(process.env.BLOB_MAX_BYTES || 25 * 1024 * 1024);

const BINARY_EXTENSIONS = new Set([
  "avif", "bmp", "gif", "heic", "jpeg", "jpg", "png", "svg", "webp",
  "pdf",
  "aac", "flac", "m4a", "mp3", "ogg", "opus", "wav",
  "m4v", "mov", "mp4", "mpeg", "webm",
]);

export function safeBlobShareId(shareId: string): boolean {
  return /^[A-Za-z0-9_.-]{1,128}$/.test(shareId);
}

export function safeBlobHash(hash: string): boolean {
  return /^[a-f0-9]{64}$/.test(hash);
}

export function safeBlobRelPath(relPath: string): string | null {
  if (!relPath || relPath.startsWith("/") || relPath.includes("\\") || relPath.includes(":")) return null;
  if (/[\x00-\x1F\x7F]/.test(relPath)) return null;
  const parts = relPath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  const ext = parts.at(-1)?.split(".").pop()?.toLowerCase() || "";
  if (!BINARY_EXTENSIONS.has(ext)) return null;
  return parts.join("/");
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function blobPath(shareId: string, hash: string): string {
  return path.join(BLOB_DIR, shareId, hash.slice(0, 2), hash);
}

export async function readBlobBody(req: http.IncomingMessage, maxBytes = BLOB_MAX_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > maxBytes) throw new Error("blob too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total);
}

export async function storeBlob(shareId: string, hash: string, data: Buffer): Promise<void> {
  if (!safeBlobShareId(shareId)) throw new Error("bad share id");
  if (!safeBlobHash(hash)) throw new Error("bad blob hash");
  if (data.byteLength > BLOB_MAX_BYTES) throw new Error("blob too large");
  const actual = sha256Hex(data);
  if (actual !== hash) throw new Error("blob hash mismatch");
  const filePath = blobPath(shareId, hash);
  try {
    const stat = await fs.stat(filePath);
    if (stat.size === data.byteLength) return;
  } catch {
    // Missing blob; write it below.
  }
  await atomicWriteFile(filePath, data);
}

export async function loadBlob(shareId: string, hash: string): Promise<Buffer | null> {
  if (!safeBlobShareId(shareId) || !safeBlobHash(hash)) return null;
  try {
    return await fs.readFile(blobPath(shareId, hash));
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}
