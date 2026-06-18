# Obsidian Collab — Real-Time Collaboration for Obsidian

Edit the same notes simultaneously, with live cursors — like Google Docs, inside Obsidian.
Share **whole folders**, give **different folders to different people**, with **roles**, **threaded
comments**, **version history**, and **deleted-file recovery**.

Built on [Yjs](https://yjs.dev) (CRDTs), `y-codemirror.next`, and `y-websocket`. One always-on
WebSocket relay server brokers changes; each synced file is a Yjs "room", and each shared folder is a
namespaced set of rooms plus a manifest.

> **Design goal: never lose data, never feedback-loop.** The bulk of the engineering here is the
> reliability layer — deterministic loop prevention, CRDT merging, tombstone deletes, offline
> reconciliation, and multiple recovery nets. See **[Reliability guarantees](#reliability-guarantees)**.

---

## Contents
- [What you get](#what-you-get)
- [Reliability guarantees](#reliability-guarantees)
- [⚠️ Using it alongside Obsidian Sync](#️-using-it-alongside-obsidian-sync) — **read this**
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Using it](#using-it)
- [Building & testing](#building--testing)
- [Operations & recovery](#operations--recovery)
- [Mobile + plugin updates](docs/RELEASES_AND_MOBILE.md)
- [Collaboration research notes](docs/COLLAB_RESEARCH_NOTES.md)
- [Project status](#project-status)

---

## What you get

| Area | Feature |
|---|---|
| **Editing** | Live multi-cursor editing (CRDT), remote selections, instant sync via CodeMirror 6 |
| **Sharing** | Per-folder shares; mount the same share at any local path; multiple independent shares |
| **Roles** | `editor` / `commenter` / `viewer`, enforced server-side; signed per-recipient invites + revoke-all |
| **Presence** | Top-of-editor facepile with self avatar, file-explorer/tab avatars where Obsidian exposes anchors, click-to-jump, per-device identity |
| **Attachments** | Images/PDF/audio/video sync as content-addressed blobs referenced from the manifest |
| **Comments** | Threaded, anchored to text, replies + emoji reactions, unread inbox; mention/thread pushes |
| **History** | Server-side git snapshots per file; browse, diff, restore whole versions or individual changes |
| **Recovery** | Deleted-file list with one-click restore; local `trash/` + `backups/`; off-box server backups |
| **Offline** | Edits persist locally (IndexedDB) and merge on reconnect; "N changes pending" indicator |
| **Mobile** | Works on Obsidian mobile (presence degrades gracefully; no desktop-only APIs) |

## Reliability guarantees

These are the properties the system is engineered to hold, and how:

- **No feedback loops.** Every plugin-initiated disk write is fingerprinted (`EchoGuard`); the vault
  event it triggers is recognized as our own echo and dropped — *deterministically, not on a timer*, so
  slow disk / mobile / batched FS events can't slip past it.
- **No lost text on concurrent edits.** Yjs CRDT merges concurrent edits conflict-free (this is the
  "how does Google Docs do it" answer — operational merge, no conflict dialog).
- **No lost text offline.** Edits made offline persist in IndexedDB and merge against the last-synced
  base when you reconnect; a snapshot is taken before any divergent reconcile.
- **Deletes are recoverable.** Deletes are **tombstones** (the manifest entry is retained, not hard
  deleted) + a local `trash/` copy + server git history. One-click restore from the history panel.
- **Conflict copies are reviewable.** Delete-vs-edit and attachment skew cases keep a visible sibling
  file and stamp the manifest so the history panel can show what original path it came from.
- **Renames preserve everything.** A rename transfers the file's full Yjs doc (text + comments +
  anchors) and stable identity (`fileId`) into the new room — not a delete+create. Synced Markdown
  notes also repair `[[wikilinks]]` and embeds that pointed at the old path.
- **Folder moves don't orphan files.** A folder move re-derives each child's rename so content and
  lineage transfer.
- **Delete-vs-edit never silently loses an edit.** If you edited a file after someone else deleted it,
  it's *resurrected* (kept) with a notice, instead of vanishing.
- **The server can fail without losing data.** Atomic state writes, corrupt-file survival (one bad
  `.yjs` never denies a room), real `/health` that 503s on save failure, git `gc`, and **off-box
  backups** (git push + full-corpus archive).

The hardened sync engine is covered by a headless **integration test** that runs the *real*
`FileProvider` through two-client convergence, no-loop, and offline-reconcile scenarios — so these
guarantees can't silently regress (`plugin/test/`, run by CI).

## ⚠️ Using it alongside Obsidian Sync

If you use **Obsidian Sync** (or any file-level sync — iCloud, Dropbox) on the **same device** as this
plugin, **exclude the shared collab folder from that other sync.**

Two independent sync systems writing the same files race each other, and a stale file-level write can
land on top of a collab write and get merged back in as "the truth" — silently reverting a
collaborator's edit. Collab is CRDT-aware; Obsidian Sync is not, and they don't coordinate.

**The fix:** in Obsidian Sync settings → selected folders, turn **off** sync for the shared folder. Then
collab is the *sole* sync for that folder across **all** your devices (phone + desktop both connect to
the relay as ordinary clients), and Obsidian Sync handles the rest of your vault. No double-write, no
races. Your own devices are just "more clients on the share" — the plugin already handles multi-device.

## Architecture

```
┌────────────── Obsidian (each collaborator) ──────────────┐        ┌──── Relay server (Railway) ────┐
│                                                          │        │                                │
│  active editor ──yCollab──┐                              │  WSS   │  per-room Y.Doc (in memory)    │
│                           ├─ per-file Y.Doc ── FileProvider ═══════╪═ mux: one socket/share        │
│  file explorer / disk ────┘   (headless sync)            │        │  atomic .yjs persistence       │
│                                                          │        │  git snapshots + blob store    │
│  manifest Y.Map ───────────── SyncManager ───────────────┼────────┼─ off-box backups (git/archive) │
│   (file tree, tombstones)                                │        │  HMAC auth + role enforcement  │
└──────────────────────────────────────────────────────────┘        └────────────────────────────────┘
```

- **Per-file Y.Doc** holds text in `Y.Text("codemirror")` and comments in `Y.Map("comments")`. The
  active editor binds via `yCollab` (live cursors); background files sync headlessly via `FileProvider`.
  Namespaced shares tunnel these rooms over one multiplexed WebSocket per share; legacy shares keep the
  original one-room-per-socket transport.
- **Binary attachments** (images, PDFs, audio/video) are uploaded as content-addressed blobs and referenced
  from the manifest by SHA-256 hash. They are not merged like text; clearly newer local attachments are
  re-published, and same-time clock-skew cases create a visible sibling conflict copy before the original
  path is updated to the remote blob. The history panel lists these conflict copies for review.
- **Per-share manifest** is a `Y.Map("files")` keyed by relative path, tracking the file tree as
  schema-v2 entries (`fileId`, `exists`, tombstone fields, additive `mutation*` provenance). `SyncManager`
  owns it and the per-file providers.
- **Rooms** are namespaced per share: `@<shareId>:__manifest__`, `@<shareId>:file:<relPath>`. The
  original single-folder setup auto-migrates to a **legacy** share that keeps the old un-prefixed rooms.
- **Server** is a content-agnostic relay: it brokers Yjs updates, persists each room's `.yjs` atomically,
  writes human-readable git snapshots per file (the history/recovery source), and enforces auth + roles.

A deep dive lives in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

### Repo layout
```
plugin/        Obsidian plugin (TypeScript → esbuild bundle)
  src/         source; collab/ = sync engine, ui/ = panels, utils/ = pure helpers
  test/        headless unit + integration tests (run by CI)
server/        Node.js WebSocket relay (TypeScript → tsc)
  src/         rooms/persistence/snapshots/blobs/auth/notify/backups/…
docs/          ARCHITECTURE.md and design notes
ROADMAP-v2-hardening.md   what's done and what's next
server/RECOVERY.md        disaster-recovery runbook
```

## Quick start

### 1. Server

Already deployed on Railway as **ObsidianSync**. To run locally:

```bash
cd server
npm install
cp .env.example .env        # then edit secrets
SERVER_SECRET=$(openssl rand -hex 24) SHARE_MINT_TOKEN=$(openssl rand -hex 16) AUTH_TOKEN=$(openssl rand -hex 16) npm run dev
```

For production, set the env vars in [Configuration](#configuration) (especially the secrets, a mounted
**volume** for `PERSIST_DIR`, and an **off-box backup**), then `railway up --detach`. The deploy is
graceful (SIGTERM flushes active docs), so redeploys are safe with live users.

### 2. Plugin

```bash
cd plugin && npm install && npm run build
# copy artifacts into your vault:
cp main.js manifest.json styles.css "<your-vault>/.obsidian/plugins/live-collab/"
```

Enable **Real-Time Collaboration** in Settings → Community Plugins.

### 3. Configure the plugin

Settings → Real-Time Collaboration:
- **Server URL** (e.g. `wss://obsidiansync-production.up.railway.app`)
- **Share admin token** (= server `SHARE_MINT_TOKEN`) — only needed to create new shares
- **Legacy server secret** is only for old servers; do not store `SERVER_SECRET` in clients for normal use
- **Server Password** (= server `AUTH_TOKEN`) — only for the legacy folder
- **Display Name** + **Cursor/Avatar Color**
- **ntfy topic** (optional) — to receive `@mention` push notifications
- **Send error telemetry** (optional) — POSTs redacted plugin error diagnostics to your collab server

## Configuration

### Server environment variables

| Var | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address |
| `SERVER_SECRET` | — | Mints/validates per-share HMAC keys. **Required in prod.** |
| `AUTH_TOKEN` | — | Global password for the legacy (un-namespaced) share |
| `ADMIN_SECRET` | = `SERVER_SECRET` | Separate secret for `/admin/revoke` (defense in depth) |
| `METRICS_TOKEN` | = `ADMIN_SECRET` | Bearer/query token required for `/metrics` when auth is enabled |
| `SHARE_MINT_TOKEN` | = `ADMIN_SECRET` | Bearer token allowed to create new shares without exposing `SERVER_SECRET` |
| `SHARE_OWNER_SECRET` | = `ADMIN_SECRET` | Derives per-share owner keys for link minting/revocation |
| `*_PREVIOUS` secret vars | — | Temporary comma-separated rotation grace vars for `SERVER_SECRET`, `AUTH_TOKEN`, `ADMIN_SECRET`, `SHARE_MINT_TOKEN`, and `SHARE_OWNER_SECRET` |
| `AUDIT_LOG_PATH` | `$PERSIST_DIR/audit.jsonl` | Append-only JSONL audit log for share/link/revoke/join/security events |
| `REQUIRE_AUTH` | `true` if `NODE_ENV=production` | Refuse to start without strong secrets |
| `MIN_SECRET_LENGTH` | `16` | Minimum secret length enforced when `REQUIRE_AUTH` |
| `DISABLE_LEGACY_ROOMS` | `false` | Reject un-namespaced rooms entirely (no `AUTH_TOKEN` needed) |
| `PERSIST_DIR` | `./collab-data` | Durable state dir — **mount a persistent volume here** |
| `WS_MAX_PAYLOAD` | `2097152` | Max inbound WS frame (anti-bloat/OOM) |
| `SYNC_DEBUG_LOG` | `false` | Emit verbose structured sync/awareness relay rows for debugging loops/glitches |
| `SYNC_LOG_LARGE_UPDATE_BYTES` | `65536` | Warn when an inbound Yjs sync update frame is this large |
| `SYNC_LOG_LARGE_TEXT_DELTA` | `20480` | Warn when a single inbound sync update changes text length by this much |
| `SERVER_LOG_DRAIN` | `true` in production, otherwise `false` | Retain redacted structured server logs to a bounded JSONL file; set `false` to disable |
| `SERVER_LOG_PATH` | `$PERSIST_DIR/server.jsonl` | Retained structured log path; `/health` reports `logDrain` status |
| `SERVER_LOG_MAX_BYTES` | `10485760` | Rotate retained server log when the active file passes this many bytes |
| `SERVER_LOG_ROTATE_COUNT` | `3` | Number of rotated retained log files to keep |
| `CLIENT_LOG_MAX_BYTES` | `65536` | Max opt-in `/clientlog` telemetry request body size |
| `BLOB_MAX_BYTES` | `26214400` | Max attachment/blob upload size |
| `BLOB_STORE` | `fs` | Attachment blob backend: `fs` or S3-compatible `s3` |
| `BLOB_S3_ENDPOINT` / `BLOB_S3_BUCKET` / `BLOB_S3_REGION` | — / — / `auto` | S3/R2 object-store endpoint, bucket, and signing region when `BLOB_STORE=s3` |
| `BLOB_S3_ACCESS_KEY_ID` / `BLOB_S3_SECRET_ACCESS_KEY` | — | S3/R2 credentials for attachment blobs |
| `BLOB_S3_PREFIX` | `obsidian-collab/blobs` | Object key prefix for S3/R2 attachment blobs |
| `BLOB_GC_GRACE_MS` | `86400000` | Minimum orphan blob age before GC may delete it |
| `BLOB_GC_INTERVAL_MS` | `0` | Optional automatic orphan blob GC cadence; `0` disables scheduled GC |
| `SAVE_SWEEP_INTERVAL_MS` | `60000` | Dirty-room persistence sweep cadence |
| `STALE_SAVE_MS` | — | `/health` 503s if dirty room state remains unsaved longer than this |
| `MIN_FREE_BYTES` | — | `/health` 503s below this much free disk |
| `NODE_OPTIONS` | `--max-old-space-size=384` in Docker | Node/V8 heap cap; raise/lower to fit the Railway memory limit |
| `MEMORY_HEALTH_MAX_RSS_BYTES` | cgroup limit × `0.92` if detectable | `/health` 503s when process RSS crosses this |
| `MEMORY_HEALTH_MAX_HEAP_USED_BYTES` | `0` | Optional `/health` heap-used ceiling; `0` disables |
| `MEMORY_HEALTH_CGROUP_RATIO` | `0.92` | RSS health threshold ratio when a container memory limit is detectable |
| `SNAPSHOT_GIT_REMOTE` / `SNAPSHOT_GIT_BRANCH` | — / `main` | Push note-history snapshots off-box |
| `REQUIRE_SNAPSHOT_REMOTE` | `true` in production, otherwise `false` | Make `/health` fail until snapshot git push is configured |
| `PERSIST_BACKUP_COMMAND` | — | Shell command for periodic full-corpus backup (gets `$PERSIST_DIR`) |
| `REQUIRE_PERSIST_BACKUP` | `true` in production, otherwise `false` | Make `/health` fail until full-corpus backups are configured |
| `PERSIST_BACKUP_INTERVAL_MS` | `86400000` | Backup cadence |
| `OPS_NTFY_TOPIC` | — | ntfy topic for save/backup/corruption alerts |
| `HEALTH_ALERT_INTERVAL_MS` | `60000` in production, otherwise `0` | Internal `/health` degradation alert cadence; set `0` if the host alerts externally |

See `server/.env.example` for a copy-paste template, and `server/RECOVERY.md` for backup/restore.

## Using it

- **Share a folder:** right-click a folder → *Share this folder (collab)* (or `Cmd+P` → *Share a
  folder…*). A **share code** is copied — send it to a collaborator. Editor links are copied by default;
  grab a view-only link from the settings tab.
- **Move/repoint a local share:** Settings → Real-Time Collaboration → that share → *Change folder…*.
  The plugin stops that share, updates the local mount folder, and restarts it. Keep independent shares as
  sibling vault folders, not nested/overlapping folders.
- **Join:** `Cmd+P` → *Add a shared folder (paste code)…*, or open an `obsidian://collab-add?code=…`
  link. The join modal pre-fills the code and suggests a friendly local folder/label.
- **Roles:** share an *editor*, *commenter*, or *viewer* link. Viewers/commenters can't write the file
  (enforced on the server). Use **Invite…** for a named/expiring recipient link that can be revoked by
  itself; invite links are bound to the first signed local install that uses them. Use **Revoke all
  links** to bump the share epoch and disconnect every old link.
- **Comments:** select text → right-click → *Add comment*. Open the comments panel from the ribbon.
- **Version history:** right-click a synced note → *Version history*, or `Cmd+P` → *Open version
  history*. Preview and restore any snapshot (a pre-restore backup is saved).
- **Recover a deleted file:** the version-history panel has a **Deleted files** section — one-click
  restore.
- **Review conflict copies:** the version-history panel has a **Conflict copies** section with Open
  actions for preserved delete/edit and attachment conflicts.

## Building & testing

```bash
# Whole repo, machine-readable report for agents/CI triage
node tools/ai-regression.mjs          # plugin tests/build + server tests/build/e2e + diagnostic-tool + diff check
node tools/ai-regression.mjs --quick  # skips the real WebSocket e2e

# Plugin
cd plugin
npm install
npm test          # headless unit + integration tests (loop-sim, manifest, textdiff, real FileProvider)
npm run build     # tsc -noEmit + esbuild production bundle

# Server
cd server
npm install
npm run build     # tsc
npm run test:e2e  # starts a temp local relay and verifies real WS sync/auth/durability
```

CI (`.github/workflows/ci.yml`) runs plugin tests, server tests, both builds, and the real-server
WebSocket e2e on every push/PR.

Manual relay check against an already running server:
```bash
cd plugin && node test/ws-sync.test.mjs <wsBase> <token>
```

Diagnostic bundles exported from the plugin are JSON and safe to hand to an AI/debugging session.
The summary tool also accepts the live `trace-....jsonl` file and highlights skipped file events,
echo drops, repeated writes, missing presence anchors, active-editor bind/unbind events, lifecycle
flushes, and per-share runtime snapshots:

```bash
node tools/diagnostics-summary.mjs "<vault-config>/plugins/live-collab/diagnostics/diagnostic-bundle-....json"
```

Server relay logs are also structured, redacted JSON rows on stdout/stderr. They include `seq`, `dt`,
`connId`, room/share metadata, rate-limit/backpressure closes, rejected writes, mux room rejections,
and suspicious update sizes, but never tokens, keys, note bodies, or raw Yjs payloads.
If **Send error telemetry** is enabled in the plugin, `err(...)` rows are also POSTed to `/clientlog`
with normal share authentication; the server logs them as redacted `client.error` rows.

Production durability gate:
```bash
node tools/prod-health-check.mjs
```

## Plugin updates

Obsidian's normal auto-update path is release based: bump `plugin/manifest.json`, `plugin/package.json`,
and `versions.json`, tag the commit with the exact version (`0.1.2`, no `v` prefix), and push the tag.
The `Release plugin` GitHub Action builds the plugin and publishes `main.js`, `manifest.json`, and
`styles.css` as release assets. Public Community Plugin listing is still what gives ordinary users
automatic updates inside Obsidian; for private testing, friends should use BRAT against the same GitHub
releases. See [Releases, Auto-Updates, and Mobile](docs/RELEASES_AND_MOBILE.md).

Public submission note: the plugin id is `live-collab` so release metadata is compatible with the
community-directory naming rule against ids containing `obsidian`. New installs should use
`.obsidian/plugins/live-collab`; the plugin imports settings from the old manual
`.obsidian/plugins/obsidian-collab/data.json` once if the new data file is empty.

## Operations & recovery

- **Health:** `GET /health` returns 503 when persistence/snapshots/backups are unhealthy (so Railway
  restarts and `OPS_NTFY_TOPIC` pages you), or when runtime memory crosses configured guardrails.
  `GET /metrics` exposes rooms, file paths, connections, runtime memory, and cumulative counters for
  save/snapshot failures, disconnects, revocations, rejected writes/paths, rate limits, backpressure
  closes, and client error telemetry. Call it with `Authorization: Bearer $METRICS_TOKEN` on public deployments.
- **Backups:** set `SNAPSHOT_GIT_REMOTE` (push history) **and** `PERSIST_BACKUP_COMMAND` (full-corpus
  archive). In production, `/health` fails until both are configured unless you explicitly set
  `REQUIRE_SNAPSHOT_REMOTE=false` / `REQUIRE_PERSIST_BACKUP=false`. Without off-box backups, all data lives
  on one volume — see the warning in `server/RECOVERY.md`.
- **Secret rotation:** set the new primary secret, put the old value in that secret's `*_PREVIOUS` env
  var, redeploy, then revoke/re-share affected shares so new codes use the new primary. Remove previous
  secrets after the grace window.
- **Blob GC:** `POST /admin/blob-gc?dryRun=true` with `Authorization: Bearer $ADMIN_SECRET` previews
  orphan attachment cleanup. Use `dryRun=false` to delete unreferenced blobs older than
  `BLOB_GC_GRACE_MS`, or set `BLOB_GC_INTERVAL_MS` for scheduled sweeps. When `BLOB_STORE=s3`, the same
  endpoint scans/deletes object-store blobs under `BLOB_S3_PREFIX`.
- **Restore:** follow `server/RECOVERY.md`.

## Project status

The reliability core (loops, lost-content, deletes/renames, offline, folder ops) is implemented and
test-covered; backend durability and security hardening are largely in place. Remaining work
(scale/HA, account-grade identity semantics, object-store polish, and the human device-matrix test) is
tracked in **[ROADMAP-v2-hardening.md](ROADMAP-v2-hardening.md)**.

**Before trusting it with important notes:** exclude the shared folder from Obsidian Sync, confirm an
off-box backup is configured, and run one deliberate two-person + mobile break-it session.
