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
- [Project status](#project-status)

---

## What you get

| Area | Feature |
|---|---|
| **Editing** | Live multi-cursor editing (CRDT), remote selections, instant sync via CodeMirror 6 |
| **Sharing** | Per-folder shares; mount the same share at any local path; multiple independent shares |
| **Roles** | `editor` / `commenter` / `viewer`, enforced server-side; revoke all links by bumping an epoch |
| **Presence** | Top-of-editor facepile, file-explorer avatars (desktop), click-to-jump, per-device identity |
| **Comments** | Threaded, anchored to text, replies + emoji reactions; survive edits; `@mention` → phone push |
| **History** | Server-side git snapshots per file; browse, preview, restore any version |
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
- **Renames preserve everything.** A rename transfers the file's full Yjs doc (text + comments +
  anchors) and stable identity (`fileId`) into the new room — not a delete+create.
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
│                           ├─ per-file Y.Doc ── FileProvider ───────┼─ relay updates to all conns   │
│  file explorer / disk ────┘   (headless sync)            │        │  atomic .yjs persistence       │
│                                                          │        │  git snapshots → history       │
│  manifest Y.Map ───────────── SyncManager ───────────────┼────────┼─ off-box backups (git/archive) │
│   (file tree, tombstones)                                │        │  HMAC auth + role enforcement  │
└──────────────────────────────────────────────────────────┘        └────────────────────────────────┘
```

- **Per-file Y.Doc** holds text in `Y.Text("codemirror")` and comments in `Y.Map("comments")`. The
  active editor binds via `yCollab` (live cursors); background files sync headlessly via `FileProvider`.
- **Per-share manifest** is a `Y.Map("files")` keyed by relative path, tracking the file tree as
  schema-v2 entries (`fileId`, `exists`, tombstone fields). `SyncManager` owns it and the per-file
  providers.
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
  src/         rooms/persistence/snapshots/auth/notify/backups/…
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
cp main.js manifest.json styles.css "<your-vault>/.obsidian/plugins/obsidian-collab/"
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
| `REQUIRE_AUTH` | `true` if `NODE_ENV=production` | Refuse to start without strong secrets |
| `MIN_SECRET_LENGTH` | `16` | Minimum secret length enforced when `REQUIRE_AUTH` |
| `DISABLE_LEGACY_ROOMS` | `false` | Reject un-namespaced rooms entirely (no `AUTH_TOKEN` needed) |
| `PERSIST_DIR` | `./collab-data` | Durable state dir — **mount a persistent volume here** |
| `WS_MAX_PAYLOAD` | `2097152` | Max inbound WS frame (anti-bloat/OOM) |
| `STALE_SAVE_MS` | — | `/health` 503s if a save is older than this while rooms are active |
| `MIN_FREE_BYTES` | — | `/health` 503s below this much free disk |
| `SNAPSHOT_GIT_REMOTE` / `SNAPSHOT_GIT_BRANCH` | — / `main` | Push note-history snapshots off-box |
| `PERSIST_BACKUP_COMMAND` | — | Shell command for periodic full-corpus backup (gets `$PERSIST_DIR`) |
| `PERSIST_BACKUP_INTERVAL_MS` | `86400000` | Backup cadence |
| `OPS_NTFY_TOPIC` | — | ntfy topic for save/backup/corruption alerts |

See `server/.env.example` for a copy-paste template, and `server/RECOVERY.md` for backup/restore.

## Using it

- **Share a folder:** right-click a folder → *Share this folder (collab)* (or `Cmd+P` → *Share a
  folder…*). A **share code** is copied — send it to a collaborator. Editor links are copied by default;
  grab a view-only link from the settings tab.
- **Join:** `Cmd+P` → *Add a shared folder (paste code)…*, or open an `obsidian://collab-add?code=…`
  link, then pick a local folder to sync into.
- **Roles:** share an *editor*, *commenter*, or *viewer* link. Viewers/commenters can't write the file
  (enforced on the server). **Revoke all links** for a share from settings (bumps the epoch; old links
  stop working, live revoked clients are disconnected).
- **Comments:** select text → right-click → *Add comment*. Open the comments panel from the ribbon.
- **Version history:** right-click a synced note → *Version history*, or `Cmd+P` → *Open version
  history*. Preview and restore any snapshot (a pre-restore backup is saved).
- **Recover a deleted file:** the version-history panel has a **Deleted files** section — one-click
  restore.

## Building & testing

```bash
# Plugin
cd plugin
npm install
npm test          # headless unit + integration tests (loop-sim, manifest, textdiff, real FileProvider)
npm run build     # tsc -noEmit + esbuild production bundle

# Server
cd server
npm install
npm run build     # tsc
```

CI (`.github/workflows/ci.yml`) runs the plugin tests + both typechecks on every push/PR.

End-to-end relay check against a running server (separate processes — y-websocket cross-talks in one
process):
```bash
cd plugin && node test/ws-sync.test.mjs <wsBase> <token>
```

Diagnostic bundles exported from the plugin are JSON and safe to hand to an AI/debugging session. For
a first-pass local summary:

```bash
node tools/diagnostics-summary.mjs "<vault-config>/plugins/obsidian-collab/diagnostics/diagnostic-bundle-....json"
```

## Plugin updates

Obsidian's normal auto-update path is release based: bump `plugin/manifest.json`, `plugin/package.json`,
and `versions.json`, tag the commit with the exact version (`0.1.2`, no `v` prefix), and push the tag.
The `Release plugin` GitHub Action builds the plugin and publishes `main.js`, `manifest.json`, and
`styles.css` as release assets. Public Community Plugin listing is still what gives ordinary users
automatic updates inside Obsidian; for private testing, friends can use BRAT or manual installs against
the same GitHub releases.

Public submission note: the current plugin id is `obsidian-collab`, which is convenient for existing
manual installs but violates Obsidian's current community-directory naming rule against ids containing
`obsidian`. Before submitting publicly, pick a new id and plan a settings/data migration.

## Operations & recovery

- **Health:** `GET /health` returns 503 when persistence/snapshots/backups are unhealthy (so Railway
  restarts and `OPS_NTFY_TOPIC` pages you). `GET /metrics` exposes rooms, file paths, connections,
  rate-limited and backpressure-closed counts, so call it with
  `Authorization: Bearer $METRICS_TOKEN` on public deployments.
- **Backups:** set `SNAPSHOT_GIT_REMOTE` (push history) **and** `PERSIST_BACKUP_COMMAND` (full-corpus
  archive). Without these, all data lives on one volume — see the warning in `server/RECOVERY.md`.
- **Restore:** follow `server/RECOVERY.md`.

## Project status

The reliability core (loops, lost-content, deletes/renames, offline, folder ops) is implemented and
test-covered; backend durability and security hardening are largely in place. Remaining work
(scale/HA, per-recipient invites/identity audit, attachment sync, version diff UI, and the human
device-matrix test) is tracked in **[ROADMAP-v2-hardening.md](ROADMAP-v2-hardening.md)**.

**Before trusting it with important notes:** exclude the shared folder from Obsidian Sync, confirm an
off-box backup is configured, and run one deliberate two-person + mobile break-it session.
