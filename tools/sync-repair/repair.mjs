#!/usr/bin/env node
// CRDT-safe repair for the 2026-09-25 duplication / resurrection incident.
//
// Edits go through the collab protocol exactly like a live-collab client:
// join the room over the share's mux socket, sync, apply Y.Text DELETES of the
// duplicate ranges only (nothing re-inserted), send the update, re-read the
// room from the server to verify. Every peer (and the running Obsidian) gets
// the deletes as ordinary remote edits. No awareness is ever sent.
//
// Gates (fail closed, per room): server text must equal the disk file; the
// planned result must pass the line-level survival proof; after applying, a
// fresh read of the server must equal the planned result. Backups of the disk
// text, server text, and full server CRDT state are written before any apply.
//
//   node repair.mjs --vault <vault> --share <id> [--folder <rel>] [--only <rel>]
//                   [--limit N] [--apply] [--ugc-tombstones] [--out <dir>]
// Credentials come from the vault's live-collab data.json and are never printed.

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { planDedupe, proveSurvival } from "./dedupe.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const req = createRequire(path.join(here, "../../plugin/package.json"));
const Y = req("yjs");
const enc = req("lib0/encoding");
const dec = req("lib0/decoding");
const WS = createRequire(path.join(here, "../../server/package.json"))("ws");

const MESSAGE_SYNC = 0, MESSAGE_MUX = 6, MESSAGE_MUX_LEAVE = 7;

const args = parseArgs(process.argv.slice(2));
const vault = args.vault;
const dataPath = path.join(vault, ".obsidian/plugins/live-collab/data.json");
const data = JSON.parse(readFileSync(dataPath, "utf8"));
const share = data.shares.find((s) => s.id === args.share);
if (!share) throw new Error("share not found in data.json");
const localRoot = path.join(vault, share.localFolder);
const outDir = args.out || path.join(process.env.HOME, ".local/state/vault-backups", `sy1-repair-${stamp()}`);
mkdirSync(outDir, { recursive: true });
const report = { startedAt: new Date().toISOString(), apply: !!args.apply, share: share.id, outDir, rooms: [], manifest: null };

function stamp() { return new Date().toISOString().replace(/[:.]/g, "-"); }
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out[key] = argv[++i];
    else out[key] = true;
  }
  return out;
}
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── mux client ────────────────────────────────────────────────────────────
class Mux {
  constructor() {
    const params = new URLSearchParams({
      token: share.key, uid: data.uid, name: "SY1 repair", color: "#888888", baseColor: "#888888",
      device: "desktop", deviceId: "sy1-repair", role: share.role, epoch: String(share.epoch),
    });
    this.url = `${data.serverUrl.replace(/\/$/, "")}/${encodeURIComponent(`@${share.id}:__mux__`)}?${params}`;
    this.waiters = new Map(); // room -> [resolve]
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WS(this.url, { maxPayload: 256 * 1024 * 1024 });
      this.ws.binaryType = "arraybuffer";
      this.ws.on("open", resolve);
      this.ws.on("error", reject);
      this.ws.on("close", (code, why) => { this.closed = `${code} ${why}`; for (const [, w] of this.waiters) w.forEach((f) => f(null)); });
      this.ws.on("message", (raw) => this.onMessage(new Uint8Array(raw)));
    });
  }
  frame(room, inner) {
    const e = enc.createEncoder();
    enc.writeVarUint(e, MESSAGE_MUX); enc.writeVarString(e, room); enc.writeVarUint8Array(e, inner);
    this.ws.send(enc.toUint8Array(e));
  }
  leave(room) {
    const e = enc.createEncoder();
    enc.writeVarUint(e, MESSAGE_MUX_LEAVE); enc.writeVarString(e, room);
    this.ws.send(enc.toUint8Array(e));
  }
  onMessage(bytes) {
    const d = dec.createDecoder(bytes);
    if (dec.readVarUint(d) !== MESSAGE_MUX) return;
    const room = dec.readVarString(d);
    const inner = dec.createDecoder(dec.readVarUint8Array(d));
    if (dec.readVarUint(inner) !== MESSAGE_SYNC) return;
    if (dec.readVarUint(inner) !== 1) return; // only sync step 2 answers our reads
    const update = dec.readVarUint8Array(inner);
    const w = this.waiters.get(room);
    if (w?.length) w.shift()(update);
  }
  /** Full server state of a room (answer to a step 1 with an empty vector). */
  read(room, timeoutMs = 30000) {
    return new Promise((resolve) => {
      const list = this.waiters.get(room) || [];
      const timer = setTimeout(() => resolve(null), timeoutMs);
      list.push((u) => { clearTimeout(timer); resolve(u); });
      this.waiters.set(room, list);
      const inner = enc.createEncoder();
      enc.writeVarUint(inner, MESSAGE_SYNC); enc.writeVarUint(inner, 0);
      enc.writeVarUint8Array(inner, Y.encodeStateVector(new Y.Doc()));
      this.frame(room, enc.toUint8Array(inner));
    });
  }
  sendUpdate(room, update) {
    const inner = enc.createEncoder();
    enc.writeVarUint(inner, MESSAGE_SYNC); enc.writeVarUint(inner, 2); enc.writeVarUint8Array(inner, update);
    this.frame(room, enc.toUint8Array(inner));
  }
}

const fileRoom = (rel) => `@${share.id}:file:${encodeURIComponent(rel)}`;
const manifestRoom = `@${share.id}:__manifest__`;

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".md") ? [p] : [];
  });
}

function backup(rel, kind, content) {
  const p = path.join(outDir, kind, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

async function repairRoom(mux, rel) {
  const room = fileRoom(rel);
  const row = { rel };
  const diskPath = path.join(localRoot, rel);
  const disk = readFileSync(diskPath, "utf8");
  const state = await mux.read(room);
  if (!state) { row.status = "read-timeout"; return row; }
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state, "server");
  const text = doc.getText("codemirror");
  const server = text.toString();
  row.serverLen = server.length; row.diskLen = disk.length;
  const plan = planDedupe(server);
  row.methods = plan.methods.join(",");
  row.planLen = plan.result.length;
  if (!plan.ranges.length) { row.status = "clean"; return row; }
  if (server !== disk) { row.status = "skip-disk-differs"; row.diskSha = sha(disk); row.serverSha = sha(server); return row; }
  const proof = proveSurvival(server, plan.result);
  row.proof = proof;
  if (!proof.ok) { row.status = "skip-proof-failed"; return row; }
  row.ranges = plan.ranges.length;
  if (!args.apply) { row.status = "dry-run-ok"; return row; }

  backup(rel, "disk", disk);
  backup(rel, "server-text", server);
  backup(rel + ".yjs-state.bin", "server-state", state);

  const updates = [];
  doc.on("update", (u, origin) => { if (origin === "sy1-repair") updates.push(u); });
  doc.transact(() => {
    for (const r of [...plan.ranges].sort((a, b) => b.start - a.start)) text.delete(r.start, r.len);
  }, "sy1-repair");
  if (text.toString() !== plan.result) { row.status = "abort-local-mismatch"; return row; }
  for (const u of updates) mux.sendUpdate(room, u);
  row.updateBytes = updates.reduce((n, u) => n + u.length, 0);

  // Verify from the server with a fresh read.
  await sleep(400);
  const after = await mux.read(room);
  const vdoc = new Y.Doc();
  if (after) Y.applyUpdate(vdoc, after, "server");
  const serverAfter = vdoc.getText("codemirror").toString();
  row.serverAfterLen = serverAfter.length;
  row.serverVerified = serverAfter === plan.result;
  if (!row.serverVerified) {
    row.concurrentProof = proveSurvival(server, serverAfter);
  }
  // Wait for the running Obsidian to project it to disk.
  let diskAfter = "";
  for (let i = 0; i < 60; i++) {
    diskAfter = readFileSync(diskPath, "utf8");
    if (diskAfter === serverAfter) break;
    await sleep(500);
  }
  row.diskVerified = diskAfter === serverAfter;
  row.diskAfterLen = diskAfter.length;
  mux.leave(room);
  row.status = row.serverVerified && row.diskVerified ? "repaired" : "applied-needs-review";
  return row;
}

async function ugcTombstones(mux) {
  const state = await mux.read(manifestRoom);
  if (!state) return { status: "read-timeout" };
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state, "server");
  const files = doc.getMap("files");
  backup("manifest.yjs-state.bin", "server-state", state);
  const now = Date.now();
  const changes = [];
  files.forEach((entry, rel) => {
    if (!rel.startsWith("UGC/") || !entry?.exists) return;
    const m = rel.match(/^UGC\/(.*?)(?: \(delete conflict [^)]+\))?\.md$/);
    if (!m) return;
    const target = `Viewd/UGC/${m[1]}.md`;
    const t = files.get(target);
    if (!t?.exists) { changes.push({ rel, skip: "no live Viewd target" }); return; }
    const top = readFileSync(path.join(localRoot, rel), "utf8");
    const dest = readFileSync(path.join(localRoot, target), "utf8");
    const a = planDedupe(top).result, b = planDedupe(dest).result;
    const destLines = new Set(b.split("\n"));
    const topOnly = [...new Set(a.split("\n"))].filter((l) => l.trim() && !destLines.has(l));
    if (topOnly.length) { changes.push({ rel, target, skip: `${topOnly.length} lines only in the top copy` }); return; }
    changes.push({ rel, target, identical: a === b });
  });
  const apply = changes.filter((c) => !c.skip);
  const result = { status: args.apply ? "applied" : "dry-run", tombstones: apply.length, skipped: changes.filter((c) => c.skip), changes };
  if (!args.apply || !apply.length) return result;
  const updates = [];
  doc.on("update", (u, origin) => { if (origin === "sy1-repair") updates.push(u); });
  doc.transact(() => {
    let seq = 0;
    for (const c of apply) {
      const prev = files.get(c.rel);
      files.set(c.rel, {
        ...prev, path: c.rel, exists: false, deleted: true, renamedTo: c.target,
        mutationId: `${data.uid}:sy1-repair:${++seq}:${now}`, mutationAction: "rename", mutationAt: now,
        mutationBy: data.displayName || "Elijah", mutationByUid: data.uid, mutationDeviceId: "sy1-repair",
        deletedBy: data.displayName || "Elijah", deletedAt: now,
      });
    }
  }, "sy1-repair");
  for (const u of updates) mux.sendUpdate(manifestRoom, u);
  await sleep(500);
  const after = await mux.read(manifestRoom);
  const vdoc = new Y.Doc();
  Y.applyUpdate(vdoc, after, "server");
  const vf = vdoc.getMap("files");
  result.verified = apply.every((c) => vf.get(c.rel)?.exists === false && vf.get(c.rel)?.renamedTo === c.target);
  return result;
}

const mux = new Mux();
await mux.open();
try {
  if (args.ugcTombstones) {
    report.manifest = await ugcTombstones(mux);
  } else {
    let rels = args.only ? [args.only] : walk(path.join(localRoot, args.folder || "")).map((p) => path.relative(localRoot, p));
    // Top-level UGC/ is retired by --ugc-tombstones, not deduped.
    rels = rels.filter((r) => !r.startsWith("UGC/")).sort();
    if (args.limit) rels = rels.slice(0, Number(args.limit));
    for (const rel of rels) {
      if (mux.closed) { report.rooms.push({ rel, status: `socket-closed ${mux.closed}` }); break; }
      const row = await repairRoom(mux, rel).catch((e) => ({ rel, status: "error", error: String(e?.message || e) }));
      report.rooms.push(row);
      if (row.status !== "clean") console.log(`${row.status.padEnd(22)} ${String(row.serverLen ?? "").padStart(8)} -> ${String(row.planLen ?? "").padStart(8)} ${row.methods || ""} ${rel}`);
      if (args.apply && row.status !== "repaired" && row.status !== "clean" && !row.status.startsWith("skip")) {
        console.log("stopping: unexpected status"); break;
      }
    }
  }
} finally {
  report.finishedAt = new Date().toISOString();
  const summaryPath = path.join(outDir, `report-${args.apply ? "apply" : "dry"}-${stamp()}.json`);
  writeFileSync(summaryPath, JSON.stringify(report, null, 1));
  const counts = {};
  for (const r of report.rooms) counts[r.status] = (counts[r.status] || 0) + 1;
  console.log("summary", JSON.stringify(counts), report.manifest ? JSON.stringify({ ...report.manifest, changes: undefined }) : "", summaryPath);
  mux.ws.close();
}
