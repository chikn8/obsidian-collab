# Architecture

How Obsidian Collab works, end to end. Pairs with the top-level
[README](../README.md) (overview) and [ROADMAP-v2-hardening.md](../ROADMAP-v2-hardening.md) (what's next).

## 1. The two-layer model

Each **share** (one local folder ↔ one namespaced room set) is synced by two cooperating layers:

1. **Per-file Y.Docs** — each file is its own Yjs document. Text lives in `Y.Text("codemirror")`;
   threaded comments live in a sibling `Y.Map("comments")` on the same doc (so they ride the same room,
   auth, and offline persistence). `FileProvider` (`plugin/src/collab/FileProvider.ts`) owns one file's
   doc and its disk round-trip.
2. **A per-share manifest** — a single `Y.Map("files")` keyed by relative path, describing the file
   tree. `SyncManager` (`plugin/src/collab/SyncManager.ts`) owns the manifest doc, all the file
   providers for the share, and file-explorer presence. The plugin runs one `SyncManager` per share.

The **active editor** additionally binds to its file's `Y.Text` via `yCollab` (`EditorBinding.ts`),
which is what makes typing feel instant and renders remote cursors/selections natively. Background
(non-focused) files keep syncing headlessly through their `FileProvider`.

### Rooms
Room names are namespaced per share so shares never collide:
- `@<shareId>:__manifest__` — the folder manifest
- `@<shareId>:file:<encodeURIComponent(relPath)>` — one per file

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
```

`schemaVersion` lives on a separate `meta` map; volatile "who last edited" stamps live on a separate
`edits` map (so a stamp can never LWW-clobber a concurrent delete on the lifecycle entry). Migration is
idempotent and LWW-converges if two clients migrate at once.

**Path safety:** manifest keys are remote-controlled, so every key is validated by `safeRelPath`
(`utils/manifestLogic.ts`) on **both** the write side and the apply side — rejecting `..`, absolute
paths, drive letters, control chars, and non-`.md` — before it can touch the vault. This closes a
path-traversal → arbitrary-file-write vector.

## 4. Delete, rename, resurrection, folder ops

- **Delete = tombstone + retain.** `onFileDelete` snapshots + trashes the content, then sets
  `exists:false` (the entry stays). The deletion replays deterministically and the file is recoverable.
- **Rename = content transfer.** `transferRename` clones the old file's *full Y.Doc state* (text +
  comments + anchors) into the new room via `encodeStateAsUpdate`, keeps the same `fileId`, and
  tombstones the old path with `renamedTo`. Not a delete+create.
- **Delete-vs-edit resurrection.** When a remote tombstone arrives for a file we still hold, if our local
  file was edited after the delete (`mtime > deletedAt + grace`, and it's not a rename tombstone), we
  **keep** it and surface a notice — never a silent loss. The predicate is the pure `shouldResurrect`.
  The startup reconcile and the live path share one `applyRemoteTombstone` helper, so the boot path can't
  silently delete an edited file either.
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

Connection identity is also stamped server-side for awareness and notifications. The client sends its
uid/name/color/device as WebSocket params, and the relay overwrites every awareness `user` object plus
notification sender fields with that connection identity. A connection can only update awareness client
IDs it introduced, so it cannot remove or overwrite another live connection's presence. This is not a
full account system; per-recipient signed identities still belong with expiring invites/audit logs.

**Roles** (`viewer`/`commenter`/`editor`) are enforced *server-side*: in `rooms.ts`, a non-editor's sync
writes (step2/update) are dropped — un-applied and un-persisted — so the read-only boundary is real, not
just UI. **Revocation** bumps a per-share `epoch` watermark (`shareState.json`); `/share/revoke` or the
legacy `/admin/revoke` raises it and disconnects live revoked clients with close code 4003.

## 7. The server

`server/src` is a content-agnostic relay:

- **`rooms.ts`** — one in-memory `WSSharedDoc` per room; relays sync + awareness to all conns. Abuse
  caps: `maxPayload`, a per-connection inbound rate limit, and `bufferedAmount` backpressure (a
  hopelessly backed-up slow peer is closed to avoid OOM). `/metrics` exposes counters and room/file
  metadata, so it is protected by `METRICS_TOKEN` whenever auth is enabled.
- **`persistence.ts`** — atomic `.yjs` saves (tmp + rename), periodic + last-disconnect + SIGTERM flush;
  corrupt files are renamed aside and the room starts empty (one bad file never denies a room);
  `getPersistenceHealth()` powers `/health`.
- **`snapshots.ts`** — writes human-readable `.md` per file into a git repo and commits on a cadence +
  SIGTERM. This is the **version-history + deleted-file recovery source**. Optional `git push` to
  `SNAPSHOT_GIT_REMOTE` for off-box history; `git gc` keeps it bounded.
- **`backups.ts`** — runs `PERSIST_BACKUP_COMMAND` on an interval for a full-corpus off-box archive.
- **`notify.ts`** — `@mention` pushes via ntfy. The topic registry is **namespaced per authed share**
  (no cross-share hijack), the sender's share comes from the connection (not the client frame), viewers
  can't send, and the client-supplied ntfy `Click` is dropped (deep-link injection guard).
- **`history.ts` / `index.ts`** — HTTP API: `/health`, `/metrics`, `/history`, `/version`, `/files`,
  `/admin/revoke`. Metrics require the metrics bearer token; read endpoints require a valid share token.

## 8. Data-flow walkthroughs

**You type in the active editor.** `yCollab` turns keystrokes into CRDT ops on the file's `Y.Text` →
`y-websocket` sends them → server relays to peers → each peer's `FileProvider` observer writes merged
text to disk (echo-guarded) and `yCollab` renders it live. Obsidian autosaves your editor to disk; that
echo is dropped.

**A peer edits a file you have closed.** Their ops arrive over your `FileProvider`'s socket → the ytext
observer fires (remote) → `writeToFile` marks the echo and writes the merged text to disk → the vault
`modify` echo is recognized and dropped.

**You delete a file.** `onFileDelete` snapshots + trashes it, tombstones the manifest entry, tears down
the provider. Peers see `exists:false`, snapshot/trash their copy, and remove it — unless they edited it
after your `deletedAt`, in which case they resurrect it and notify.

**You go offline and edit.** Edits persist in IndexedDB and bump the "pending" counter. On reconnect, the
provider re-syncs; the offline ops merge into the server state conflict-free.
