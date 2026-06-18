# Architecture

How Obsidian Collab works, end to end. Pairs with the top-level
[README](../README.md) (overview) and [ROADMAP-v2-hardening.md](../ROADMAP-v2-hardening.md) (what's next).

## 1. The two-layer model

Each **share** (one local folder ↔ one namespaced room set) is synced by three cooperating layers:

1. **Per-file text Y.Docs** — each Markdown/Canvas file is its own Yjs document. Text lives in `Y.Text("codemirror")`;
   threaded comments live in a sibling `Y.Map("comments")` on the same doc (so they ride the same room,
   auth, and offline persistence). `FileProvider` (`plugin/src/collab/FileProvider.ts`) owns one file's
   doc and its disk round-trip.
2. **A per-share manifest** — a single `Y.Map("files")` keyed by relative path, describing the file
   tree. `SyncManager` (`plugin/src/collab/SyncManager.ts`) owns the manifest doc, all the file
   providers for the share, and file-explorer/tab presence where Obsidian exposes compatible DOM anchors.
   The plugin runs one `SyncManager` per share.
3. **Content-addressed blobs** — binary attachments are uploaded to `/blob` by SHA-256 hash and referenced
   from manifest entries (`kind:"binary"`, `blobHash`, `blobSize`). They are not CRDT merged: clearly newer
   local files are re-published, clearly older files accept the remote blob, and skew-window collisions keep
   a visible `(... binary conflict ...).ext` sibling before the original path is updated. Conflict copies
   carry `conflict*` manifest metadata so the history panel can list and open them later.

The **active editor** additionally binds to its file's `Y.Text` via `yCollab` (`EditorBinding.ts`),
which is what makes typing feel instant and renders remote cursors/selections natively. Background
(non-focused) files keep syncing headlessly through their `FileProvider`.

Namespaced shares use a multiplexed WebSocket transport: one authenticated physical socket per
client/share carries frames for the manifest and each text-file room. The server still stores and evicts
separate `WSSharedDoc` rooms internally, so persistence/history behavior is unchanged. Legacy shares keep
the old one-room-per-socket transport for compatibility.

Local mount folders are per-device settings, not server identity. A user can repoint a share to a new
vault folder from settings; the plugin stops that share, updates `localFolder`, and restarts it. Nested or
overlapping share roots are still blocked because there is no most-specific-wins ownership model yet.

### Rooms
Room names are namespaced per share so shares never collide:
- `@<shareId>:__manifest__` — the folder manifest
- `@<shareId>:file:<encodeURIComponent(relPath)>` — one per text file
- `@<shareId>:__mux__` — the physical multiplex socket endpoint for a namespaced share

The original single-folder setup auto-migrates to a **legacy** share that keeps the old *un-prefixed*
rooms (`__manifest__`, `file:…`) so existing data and collaborators are untouched. `share.legacy` and
`histShareId === "legacy"` thread this special case through the client and the server snapshot paths.

## 2. Feedback-loop prevention (`EchoGuard`)

The hazard: the plugin **writes** to the vault (remote change → disk) and also **listens** to vault
events (disk change → ytext). Every plugin write produces an echo event that must not re-enter Yjs, or
the system oscillates.

The old approach used `setTimeout` windows to ignore echoes — fragile on mobile / slow disk / batched FS
events, where the echo arrives after the window expires. The current `EchoGuard`
(`plugin/src/collab/EchoGuard.ts`) is **content-based, not time-based**:

- Before any plugin-initiated `modify`/`create`/`delete`, it records a **fingerprint** (`length + FNV-1a`)
  of exactly what was written.
- An incoming vault event whose content matches a recent fingerprint is provably our own echo and is
  dropped — *regardless of how late it arrives*. Timing never affects correctness.
- A small **ring** of recent fingerprints per path (not just the latest) defends the "stale echo" race:
  if we write V2 then quickly V3 (a remote op merged in between), the late V2 echo is still recognized
  and dropped instead of diffing against the newer V3 ytext and clobbering the merge.
- **Create/delete** echoes use distinct sentinels (consumed on match), kept in a separate namespace from
  content fingerprints, so an empty-file create echo can never be confused with a genuine empty write.
- A module-global **re-entrancy depth** (`beginRemoteApply`/`endRemoteApply`) skips vault events
  delivered synchronously while we're applying a remote change.

A TTL bounds memory only; it is never the primary guard. The headless integration test drives the real
`FileProvider` through jittered round-trips and asserts the disk-write count stays bounded.

## 3. The manifest (schema v2)

`ManifestEntry` (`plugin/src/types.ts`) is additive over the v1 shape (old clients ignore new fields):

```
fileId?      stable identity (crypto.randomUUID), assigned on create, preserved across rename
path?        redundant copy of the map key (so renames carry the path)
exists       false ⇒ tombstone (entry retained, NOT hard-deleted)
deleted, deletedBy, deletedAt
renamedFrom, renamedTo
restoredBy/At, resurrectedBy
mutationId, mutationAction, mutationAt, mutationByUid, mutationDeviceId
```

`schemaVersion` lives on a separate `meta` map; volatile "who last edited" stamps live on a separate
`edits` map with actor uid + device provenance (so a stamp can never LWW-clobber a concurrent delete on
the lifecycle entry, and old-client tombstones can still be reconciled more conservatively). Migration is
idempotent and LWW-converges if two clients migrate at once.

Every local lifecycle mutation also stamps the manifest entry with additive operation provenance
(`mutationId`, local sequence, actor uid, and device id/kind). These stamps do not authorize anything and
do not replace Yjs conflict resolution; they make delete/rename/blob feedback loops traceable to one
device operation in diagnostics, history, and exported manifest state.

**Path safety:** manifest keys are remote-controlled, so every key is validated by `safeRelPath`
(`utils/manifestLogic.ts`) on **both** the write side and the apply side — rejecting `..`, absolute
paths, drive letters, control chars, and unsupported extensions before it can touch the vault. Text is
limited to `.md` / `.canvas`; binary attachments are limited to known image/PDF/audio/video extensions.
This closes a path-traversal → arbitrary-file-write vector.

## 4. Delete, rename, resurrection, folder ops

- **Delete = tombstone + retain.** `onFileDelete` snapshots + trashes the content, then sets
  `exists:false` (the entry stays). The deletion replays deterministically and the file is recoverable.
- **Rename = content transfer.** `transferRename` clones the old file's *full Y.Doc state* (text +
  comments + anchors) into the new room via `encodeStateAsUpdate`, keeps the same `fileId`, and
  tombstones the old path with `renamedTo`. Not a delete+create.
- **Link repair on rename.** A live entry with `renamedFrom` triggers a CRDT-backed rewrite of
  `[[wikilinks]]`/embeds in synced Markdown notes, preserving aliases/subpaths and skipping code.
- **Delete-vs-edit reconciliation.** When a remote tombstone arrives for a file we still hold, the shared
  `applyRemoteTombstone` helper makes the same decision on startup and live updates. Mutation provenance
  prevents wall-clock-only resurrection across devices: same-device tombstones delete, different-device
  apparent-newer local copies become visible `(... delete conflict ...).md`/attachment copies, and
  old/no-provenance tombstones also conflict-copy when this install has a provenance-stamped local edit.
  Rename tombstones never resurrect because the content moved to the new path. Conflict copies are stamped
  with the original path and source operation so they remain reviewable in the history panel instead of
  being filename-only breadcrumbs.
- **Folder move/rename/delete.** Obsidian fires a *single* event for a folder (not per child), so
  `onFolderRename`/`onFolderDelete` enumerate descendants and route each through the per-file path,
  preserving content and lineage. (Without this, dragging a folder orphans every file inside it.)

## 5. Offline reconciliation

`FileProvider.start` runs three layers before the WebSocket connects:

1. **IndexedDB** (`y-indexeddb`) — all CRDT ops persist locally, so offline edits survive restarts.
2. **Rename seed** (if applicable) — clone prior doc state into a fresh room.
3. **Disk → Yjs reconcile** — if the file changed on disk while the plugin was off (a crash, or you
   edited it in another app/device), diff the disk against the **IndexedDB last-synced text (the common
   ancestor)** and apply only the changed span as Yjs ops, so they *join* the CRDT merge instead of being
   clobbered. A snapshot is taken first.

Because reconciliation diffs against the ancestor (not a blind replace), concurrent remote edits
elsewhere survive the merge. A status-bar indicator counts local edits made while disconnected ("N
changes pending") and clears on resync.

## 6. Auth, roles, revocation

Two tiers (`server/src/auth.ts`, `index.ts`):
- **Legacy rooms** use the global `AUTH_TOKEN`.
- **Namespaced shares** use a per-share capability token: `key = HMAC(SERVER_SECRET, "<id>:<role>:<epoch>")`.
  The server validates it for the room's shareId — you can't forge another share's key unless you hold
  `SERVER_SECRET`.

New shares are minted server-side through `/share/create`, authenticated by `SHARE_MINT_TOKEN`, so
`SERVER_SECRET` no longer has to be stored in plugin settings. The creator receives an editor role key
plus a scoped `ownerKey` for that share. Later role links are minted through `/share/link`, and revocation
uses `/share/revoke`; both require the share's owner key and cannot derive keys for other shares.
Per-recipient invites are minted through `/share/invite`; their HMAC includes role, epoch, invite id, and
optional expiry. Invite joins and invite-authenticated history reads also carry a signed per-install
identity (`uid`, P-256 public key, signature). The first valid install to use an invite binds that invite.
By default later uses must present the same uid + public key; the creator can raise `maxDevices` on the
invite to allow a bounded set of signed installs for the same recipient. `/share/invite/revoke` disables
one invite and disconnects only sockets using that invite.

Secret rotation is a grace-window model. The current primary env vars mint all new share/link/invite
tokens. Optional comma-separated `*_PREVIOUS` env vars (`SERVER_SECRET_PREVIOUS`, `AUTH_TOKEN_PREVIOUS`,
`ADMIN_SECRET_PREVIOUS`, `SHARE_MINT_TOKEN_PREVIOUS`, `SHARE_OWNER_SECRET_PREVIOUS`) verify old tokens
during a temporary rotation window. Remove previous secrets after shares are revoked/re-shared onto the
new primary values.

Connection identity is also stamped server-side for awareness and notifications. The client sends its
uid/name/device-scoped color/baseColor/device as WebSocket params, and the relay overwrites every
awareness `user` object plus notification sender fields with that connection identity. A connection can
only update awareness client IDs it introduced, so it cannot remove or overwrite another live connection's
presence. Cursor labels use a device-aware `user.name` such as `Elijah (mobile)`, while plugin UI prefers
`user.displayName` plus a separate device suffix so facepiles, mentions, and hover labels do not duplicate
device text. Each install keeps its own `deviceId`; cursor colors, self-selection overlays, file-tree
badges, tab badges, and facepiles all use the same per-device color variant, while `baseColor` remains
available for grouping/debugging. Mention autocomplete groups live same-name installs into one visible
person row and fans a mention notification out to each live uid behind that name. This is still not a full
account system: there is no central login or cross-device key recovery. Security-relevant
share/link/invite/revoke/join/reject events are written to the server audit JSONL log.

**Roles** (`viewer`/`commenter`/`editor`) are enforced *server-side*: in `rooms.ts`, a non-editor's sync
writes (step2/update) are dropped — un-applied and un-persisted — so the read-only boundary is real, not
just UI. **Revocation** bumps a per-share `epoch` watermark (`shareState.json`); `/share/revoke` or the
legacy `/admin/revoke` raises it and disconnects live revoked clients with close code 4003.

## 7. The server

`server/src` is a content-agnostic relay:

- **`rooms.ts`** — one in-memory `WSSharedDoc` per room; relays sync + awareness to all conns. Abuse
  caps: `maxPayload`, a per-connection inbound rate limit, and `bufferedAmount` backpressure (a
  hopelessly backed-up slow peer is closed to avoid OOM). Socket close cleanup uses a per-connection
  room index rather than scanning every active room. `/metrics` exposes cumulative counters, runtime memory,
  and room/file metadata, so it is protected by `METRICS_TOKEN` whenever auth is enabled. The hot relay path
  emits redacted structured logs for joins/leaves, rejected writes, mux room rejections, rate limits,
  backpressure closes, suspicious update sizes, and awareness debug rows when `SYNC_DEBUG_LOG=true`. In
  production, those redacted rows are also retained to a bounded rotating JSONL drain; `/health` and
  `/metrics` expose `logDrain` status.
- **`/clientlog`** — opt-in plugin error telemetry. Clients authenticate with an existing share token
  (including role/invite identity params where applicable), POST only redacted `err(...)` diagnostics, and
  the server re-normalizes the body before emitting a structured `client.error` log row. Manifest/file
  provider `connection-error` events feed this same path with share/file context. This is debugging
  telemetry, not a trust boundary for secrets.
- **`persistence.ts`** — atomic `.yjs` saves (tmp + rename), one global dirty-room save sweep,
  last-disconnect saves, and SIGTERM flush; corrupt files are renamed aside and the room starts empty
  (one bad file never denies a room); `getPersistenceHealth()` powers `/health`.
- **`snapshots.ts`** — writes human-readable `.md` / `.canvas` text snapshots into a git repo and commits on a cadence +
  SIGTERM. This is the **version-history + deleted-file recovery source**. Optional `git push` to
  `SNAPSHOT_GIT_REMOTE` for off-box history; `git gc` keeps it bounded.
- **`blobs.ts` / `blobStore.ts`** — stores content-addressed attachment blobs either under
  `$PERSIST_DIR/blobs/<share>/<hash>` (`BLOB_STORE=fs`) or in an S3-compatible object store such as R2
  (`BLOB_STORE=s3`). Upload is editor-only, download is any valid share role, and the server verifies
  SHA-256 before writing.
- **`blobGc.ts`** — scans persisted manifests for referenced `blobHash` values and removes old
  unreferenced blobs from the configured blob store by admin command or optional interval.
- **`backups.ts`** — runs `PERSIST_BACKUP_COMMAND` on an interval for a full-corpus off-box archive. In
  production, `/health` requires both the snapshot remote and this full-corpus backup unless explicitly
  disabled.
- **`healthMonitor.ts`** — optional in-process `/health` monitor. In production it checks the same
  aggregate health object on a cadence and sends deduped `OPS_NTFY_TOPIC` alerts when any component is
  degraded, so deployments do not depend solely on platform-level health alerts.
- **`notify.ts`** — `@mention` pushes via ntfy. The topic registry is **namespaced per authed share**
  (no cross-share hijack), the sender's share comes from the connection (not the client frame), viewers
  can't send, and ntfy `Click` links are derived only from sanitized vault-relative Markdown/Canvas paths.
- **`history.ts` / `index.ts`** — HTTP API: `/health`, `/metrics`, `/history`, `/version`, `/files`,
  `/blob`, `/admin/revoke`, `/share/invite`, `/share/invite/revoke`. Metrics require the metrics bearer token;
  read endpoints require a valid share token, and invite reads require the same signed install identity
  binding as WebSocket joins.

## 8. Data-flow walkthroughs

**You type in the active editor.** `yCollab` turns keystrokes into CRDT ops on the file's `Y.Text` →
`y-websocket` sends them → server relays to peers → each peer's `FileProvider` observer writes merged
text to disk (echo-guarded) and `yCollab` renders it live. Obsidian autosaves your editor to disk; that
echo is dropped.

**A peer edits a file you have closed.** Their ops arrive over your `FileProvider`'s socket → the ytext
observer fires (remote) → `writeToFile` marks the echo and writes the merged text to disk → the vault
`modify` echo is recognized and dropped.

**You delete a file.** `onFileDelete` tombstones the manifest entry; text files also snapshot/trash local
content and tear down their provider. Peers see `exists:false` and remove their copy — unless they edited
it after your `deletedAt`, in which case they resurrect it and notify. Binary deletes retain the blob hash
on the tombstone, so restore can download the attachment again.

**You go offline and edit.** Edits persist in IndexedDB and bump the "pending" counter. On reconnect, the
provider re-syncs; the offline ops merge into the server state conflict-free.
