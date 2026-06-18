import { createHash, createHmac } from "crypto";
import fs from "fs/promises";
import path from "path";
import { atomicWriteFile } from "./storage.js";

export interface StoredBlob {
  shareId: string;
  hash: string;
  size: number;
  updatedAt: number;
}

export interface BlobStore {
  readonly mode: "fs" | "s3";
  put(shareId: string, hash: string, data: Buffer): Promise<void>;
  get(shareId: string, hash: string): Promise<Buffer | null>;
  list(): AsyncIterable<StoredBlob>;
  delete(shareId: string, hash: string): Promise<void>;
  configured(): { ok: boolean; mode: string; error?: string };
}

const PERSIST_DIR = process.env.PERSIST_DIR || "./collab-data";
const BLOB_DIR = path.join(PERSIST_DIR, "blobs");

export function configuredBlobStoreMode(): "fs" | "s3" {
  return process.env.BLOB_STORE === "s3" ? "s3" : "fs";
}

class FsBlobStore implements BlobStore {
  readonly mode = "fs" as const;

  configured() {
    return { ok: true, mode: this.mode };
  }

  async put(shareId: string, hash: string, data: Buffer): Promise<void> {
    const filePath = fsBlobPath(shareId, hash);
    try {
      const stat = await fs.stat(filePath);
      if (stat.size === data.byteLength) return;
    } catch {
      // Missing blob; write it below.
    }
    await atomicWriteFile(filePath, data);
  }

  async get(shareId: string, hash: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(fsBlobPath(shareId, hash));
    } catch (e: any) {
      if (e?.code === "ENOENT") return null;
      throw e;
    }
  }

  async *list(): AsyncIterable<StoredBlob> {
    const shares = await fs.readdir(BLOB_DIR, { withFileTypes: true }).catch((e: any) => {
      if (e?.code === "ENOENT") return [];
      throw e;
    });
    for (const share of shares) {
      if (!share.isDirectory()) continue;
      const shareId = share.name;
      const shareDir = path.join(BLOB_DIR, shareId);
      const prefixes = await fs.readdir(shareDir, { withFileTypes: true }).catch(() => []);
      for (const prefix of prefixes) {
        if (!prefix.isDirectory()) continue;
        const prefixDir = path.join(shareDir, prefix.name);
        const files = await fs.readdir(prefixDir, { withFileTypes: true }).catch(() => []);
        for (const file of files) {
          if (!file.isFile()) continue;
          const filePath = path.join(prefixDir, file.name);
          const stat = await fs.stat(filePath).catch(() => null);
          if (!stat) continue;
          yield { shareId, hash: file.name, size: stat.size, updatedAt: stat.mtimeMs };
        }
      }
    }
  }

  async delete(shareId: string, hash: string): Promise<void> {
    const filePath = fsBlobPath(shareId, hash);
    const prefixDir = path.dirname(filePath);
    const shareDir = path.dirname(prefixDir);
    await fs.rm(filePath, { force: true });
    await removeEmptyDir(prefixDir);
    await removeEmptyDir(shareDir);
  }
}

class S3BlobStore implements BlobStore {
  readonly mode = "s3" as const;
  private endpoint: URL;
  private bucket: string;
  private region: string;
  private accessKeyId: string;
  private secretAccessKey: string;
  private sessionToken: string;
  private keyPrefix: string;

  constructor() {
    this.endpoint = new URL(process.env.BLOB_S3_ENDPOINT || "https://s3.amazonaws.com");
    this.bucket = process.env.BLOB_S3_BUCKET || "";
    this.region = process.env.BLOB_S3_REGION || "auto";
    this.accessKeyId = process.env.BLOB_S3_ACCESS_KEY_ID || "";
    this.secretAccessKey = process.env.BLOB_S3_SECRET_ACCESS_KEY || "";
    this.sessionToken = process.env.BLOB_S3_SESSION_TOKEN || "";
    this.keyPrefix = normalizePrefix(process.env.BLOB_S3_PREFIX || "obsidian-collab/blobs");
  }

  configured() {
    if (!this.bucket) return { ok: false, mode: this.mode, error: "BLOB_S3_BUCKET is required" };
    if (!this.accessKeyId) return { ok: false, mode: this.mode, error: "BLOB_S3_ACCESS_KEY_ID is required" };
    if (!this.secretAccessKey) return { ok: false, mode: this.mode, error: "BLOB_S3_SECRET_ACCESS_KEY is required" };
    return { ok: true, mode: this.mode };
  }

  async put(shareId: string, hash: string, data: Buffer): Promise<void> {
    this.assertConfigured();
    const res = await this.request("PUT", this.key(shareId, hash), {}, data);
    if (!res.ok) throw new Error(`s3 put failed ${res.status}: ${await safeResponseText(res)}`);
  }

  async get(shareId: string, hash: string): Promise<Buffer | null> {
    this.assertConfigured();
    const res = await this.request("GET", this.key(shareId, hash));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`s3 get failed ${res.status}: ${await safeResponseText(res)}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async *list(): AsyncIterable<StoredBlob> {
    this.assertConfigured();
    let continuationToken = "";
    do {
      const query: Record<string, string> = {
        "list-type": "2",
        prefix: this.keyPrefix,
      };
      if (continuationToken) query["continuation-token"] = continuationToken;
      const res = await this.request("GET", "", query);
      if (!res.ok) throw new Error(`s3 list failed ${res.status}: ${await safeResponseText(res)}`);
      const parsed = parseListObjectsXml(await res.text());
      for (const object of parsed.objects) {
        const rel = object.key.startsWith(this.keyPrefix) ? object.key.slice(this.keyPrefix.length) : "";
        const [shareId, prefix, hash] = rel.split("/");
        if (!shareId || !prefix || !hash || hash.slice(0, 2) !== prefix) continue;
        yield {
          shareId,
          hash,
          size: object.size,
          updatedAt: Date.parse(object.lastModified) || 0,
        };
      }
      continuationToken = parsed.nextContinuationToken || "";
    } while (continuationToken);
  }

  async delete(shareId: string, hash: string): Promise<void> {
    this.assertConfigured();
    const res = await this.request("DELETE", this.key(shareId, hash));
    if (!res.ok && res.status !== 404) throw new Error(`s3 delete failed ${res.status}: ${await safeResponseText(res)}`);
  }

  private key(shareId: string, hash: string): string {
    return `${this.keyPrefix}${shareId}/${hash.slice(0, 2)}/${hash}`;
  }

  private assertConfigured(): void {
    const status = this.configured();
    if (!status.ok) throw new Error(status.error || "blob store is not configured");
  }

  private objectUrl(key: string, query: Record<string, string> = {}): URL {
    const url = new URL(this.endpoint.toString());
    const basePath = url.pathname.replace(/\/+$/, "");
    url.pathname = key
      ? `${basePath}/${this.bucket}/${key}`.replace(/\/{2,}/g, "/")
      : `${basePath}/${this.bucket}`.replace(/\/{2,}/g, "/");
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    return url;
  }

  private async request(
    method: string,
    key: string,
    query: Record<string, string> = {},
    body: Buffer = Buffer.alloc(0)
  ): Promise<Response> {
    const url = this.objectUrl(key, query);
    const payloadHash = sha256Hex(body);
    const now = new Date();
    const amzDate = timestamp(now);
    const headers: Record<string, string> = {
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    if (this.sessionToken) headers["x-amz-security-token"] = this.sessionToken;
    headers.authorization = this.authorization(method, url, headers, payloadHash, datestamp(now));
    const requestBody = method === "GET" || method === "DELETE" ? undefined : body as unknown as BodyInit;
    return fetch(url, { method, headers, body: requestBody });
  }

  private authorization(
    method: string,
    url: URL,
    headers: Record<string, string>,
    payloadHash: string,
    date: string
  ): string {
    const canonicalHeaders = canonicalHeaderString(url, headers);
    const signedHeaders = signedHeaderNames(headers);
    const scope = `${date}/${this.region}/s3/aws4_request`;
    const canonicalRequest = [
      method,
      canonicalUri(url),
      canonicalQuery(url),
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      headers["x-amz-date"],
      scope,
      sha256Hex(Buffer.from(canonicalRequest)),
    ].join("\n");
    const signature = hmacHex(signingKey(this.secretAccessKey, date, this.region), stringToSign);
    return `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  }
}

let store: BlobStore | null = null;

export function getBlobStore(): BlobStore {
  if (!store) store = configuredBlobStoreMode() === "s3" ? new S3BlobStore() : new FsBlobStore();
  return store;
}

function fsBlobPath(shareId: string, hash: string): string {
  return path.join(BLOB_DIR, shareId, hash.slice(0, 2), hash);
}

async function removeEmptyDir(dir: string): Promise<void> {
  await fs.rmdir(dir).catch((e: any) => {
    if (e?.code !== "ENOENT" && e?.code !== "ENOTEMPTY") throw e;
  });
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+|\/+$/g, "");
  return trimmed ? `${trimmed}/` : "";
}

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function hmacHex(key: Buffer, data: string): string {
  return createHmac("sha256", key).update(data).digest("hex");
}

function signingKey(secret: string, date: string, region: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
}

function timestamp(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function datestamp(date: Date): string {
  return timestamp(date).slice(0, 8);
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalUri(url: URL): string {
  return url.pathname.split("/").map((part) => encodeRfc3986(decodeURIComponent(part))).join("/") || "/";
}

function canonicalQuery(url: URL): string {
  return Array.from(url.searchParams.entries())
    .sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv))
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
    .join("&");
}

function signedHeaderNames(headers: Record<string, string>): string {
  return ["host", ...Object.keys(headers).map((name) => name.toLowerCase())].sort().join(";");
}

function canonicalHeaderString(url: URL, headers: Record<string, string>): string {
  return ["host", ...Object.keys(headers)]
    .map((name) => name.toLowerCase())
    .sort()
    .map((name) => {
      const value = name === "host" ? url.host : headers[name] ?? headers[Object.keys(headers).find((h) => h.toLowerCase() === name) || ""];
      return `${name}:${String(value).trim().replace(/\s+/g, " ")}\n`;
    })
    .join("");
}

async function safeResponseText(res: Response): Promise<string> {
  return (await res.text().catch(() => "")).slice(0, 500);
}

function xmlText(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? decodeXml(match[1]) : "";
}

function parseListObjectsXml(xml: string): {
  nextContinuationToken: string;
  objects: { key: string; size: number; lastModified: string }[];
} {
  const objects: { key: string; size: number; lastModified: string }[] = [];
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const item = match[1];
    const key = xmlText(item, "Key");
    const size = Number(xmlText(item, "Size") || 0);
    const lastModified = xmlText(item, "LastModified");
    if (key) objects.push({ key, size, lastModified });
  }
  return {
    nextContinuationToken: xmlText(xml, "NextContinuationToken"),
    objects,
  };
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
