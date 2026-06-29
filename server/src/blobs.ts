import type http from "http";
import { createHash } from "crypto";
import { getBlobStore, type StoredBlob } from "./blobStore.js";

export const BLOB_MAX_BYTES = Number(process.env.BLOB_MAX_BYTES || 25 * 1024 * 1024);

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
  // Sync is markdown-only; keep blob storage readable for old data, but reject new uploads.
  return null;
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
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
  await getBlobStore().put(shareId, hash, data);
}

export async function loadBlob(shareId: string, hash: string): Promise<Buffer | null> {
  if (!safeBlobShareId(shareId) || !safeBlobHash(hash)) return null;
  return getBlobStore().get(shareId, hash);
}

export async function* listStoredBlobs(): AsyncIterable<StoredBlob> {
  for await (const blob of getBlobStore().list()) yield blob;
}

export async function deleteStoredBlob(shareId: string, hash: string): Promise<void> {
  if (!safeBlobShareId(shareId) || !safeBlobHash(hash)) return;
  await getBlobStore().delete(shareId, hash);
}

export function getBlobStorageHealth() {
  return getBlobStore().configured();
}
