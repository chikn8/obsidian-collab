import { createHash } from "crypto";
import http from "http";
import { once } from "events";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function xmlEscape(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

console.log("server blob s3\n");

const objects = new Map();
const requests = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const body = await readBody(req);
  requests.push({
    method: req.method,
    path: url.pathname,
    query: url.search,
    authorization: req.headers.authorization || "",
    contentSha: req.headers["x-amz-content-sha256"] || "",
  });

  const parts = decodeURIComponent(url.pathname).split("/").filter(Boolean);
  if (parts[0] !== "test-bucket") {
    res.writeHead(404).end();
    return;
  }

  if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
    const prefix = url.searchParams.get("prefix") || "";
    let xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult>";
    for (const [key, value] of objects) {
      if (!key.startsWith(prefix)) continue;
      xml += `<Contents><Key>${xmlEscape(key)}</Key><LastModified>${value.updatedAt}</LastModified><Size>${value.body.byteLength}</Size></Contents>`;
    }
    xml += "</ListBucketResult>";
    res.writeHead(200, { "Content-Type": "application/xml" }).end(xml);
    return;
  }

  const key = parts.slice(1).join("/");
  if (req.method === "PUT") {
    objects.set(key, { body, updatedAt: "2026-06-18T00:00:00.000Z" });
    res.writeHead(200).end();
    return;
  }
  if (req.method === "GET") {
    const object = objects.get(key);
    if (!object) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/octet-stream" }).end(object.body);
    return;
  }
  if (req.method === "DELETE") {
    objects.delete(key);
    res.writeHead(204).end();
    return;
  }
  res.writeHead(405).end();
});

server.listen(0, "127.0.0.1");
await once(server, "listening");

try {
  const address = server.address();
  const endpoint = `http://127.0.0.1:${address.port}`;
  process.env.BLOB_STORE = "s3";
  process.env.BLOB_S3_ENDPOINT = endpoint;
  process.env.BLOB_S3_BUCKET = "test-bucket";
  process.env.BLOB_S3_REGION = "auto";
  process.env.BLOB_S3_ACCESS_KEY_ID = "test-access";
  process.env.BLOB_S3_SECRET_ACCESS_KEY = "test-secret";
  process.env.BLOB_S3_PREFIX = "test-prefix";

  const {
    deleteStoredBlob,
    getBlobStorageHealth,
    listStoredBlobs,
    loadBlob,
    storeBlob,
  } = await import("../src/blobs.ts");

  const body = Buffer.from("s3 blob bytes");
  const hash = sha256(body);

  check("s3 store is configured", getBlobStorageHealth().ok === true, JSON.stringify(getBlobStorageHealth()));
  await storeBlob("share-s3", hash, body);
  check("s3 upload sends aws authorization", String(requests[0]?.authorization).startsWith("AWS4-HMAC-SHA256"), JSON.stringify(requests[0]));
  check("s3 upload signs payload hash", requests[0]?.contentSha === hash, JSON.stringify(requests[0]));

  check("s3 blob can be read", (await loadBlob("share-s3", hash))?.equals(body));
  const listed = [];
  for await (const blob of listStoredBlobs()) listed.push(blob);
  check("s3 list exposes stored blob", listed.some((b) => b.shareId === "share-s3" && b.hash === hash && b.size === body.byteLength), JSON.stringify(listed));

  await deleteStoredBlob("share-s3", hash);
  check("s3 delete removes blob", await loadBlob("share-s3", hash) === null);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
