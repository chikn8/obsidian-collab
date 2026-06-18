# obsidian-collab — Robustness v2 Roadmap (HANDOFF / PLAN)

> **Purpose.** This is the follow-on plan after the v1 "Google-Docs-grade robustness" pass
> (loop guards, never-lose net, tombstone delete/rename, offline + mobile) landed and passed
> review. A 6-lens audit of the *current* working tree (56 findings) surfaced gaps the v1 pass
> never reached, clustered in **security, durability/ops, scale, test coverage, and feature parity**.
> Every file:line below was verified against the working tree on the `feat/robustness-hardening`
> branch. This doc is self-sufficient — an implementer (or Codex) can work straight from it.

Repo: `~/obsidian-collab-work` · Build: `cd plugin && npm run build`; `cd server && npm run build` ·
Deploy: `railway up --detach` (project `577f92e6…` ObsidianSync; prod `https://obsidiansync-production.up.railway.app`) ·
Tests: `cd plugin && npm test` (pure-unit) + `node test/ws-sync.test.mjs <wsBase> <token>` (manual e2e).

## What's already DONE (do not redo)
Deterministic content-fingerprint loop guard (`EchoGuard`), re-entrancy depth, stale-echo ring,
create/delete sentinels · never-lose: `flushSnapshot`+local trash before destroy, deleted-file
recovery UI + restore, pre-reconcile snapshot, server git history, additive `/files` endpoint ·
manifest schema v2 (additive, migrated): `fileId`, tombstone deletes, rename = full Y.Doc transfer,
delete-vs-edit resurrection, shared `applyRemoteTombstone`, durable `mutation*` provenance on lifecycle
entries · offline IDB-base reconcile + "N pending" indicator · mobile-safe presence, clipboard fallbacks,
multi-instance detection · atomic `.yjs` saves, graceful SIGTERM, active revocation (epoch + 4003 close),
per-device presence, Tier-2 per-share HMAC.

## ✅ Completed since this roadmap was written
**Tier 0** (durability + security quick wins): path-traversal guard (`safeRelPath`, both sides) ·
off-box backups (`SNAPSHOT_GIT_REMOTE` git push + `PERSIST_BACKUP_COMMAND` archive) · real `/health`
durability checks + 503 + `OPS_NTFY_TOPIC` alerts · atomic state writes + fail-closed parse ·
corrupt-`.yjs` survival · `git gc` · refuse-to-start on weak secrets (`REQUIRE_AUTH`, `ADMIN_SECRET`,
`MIN_SECRET_LENGTH`) · `debugLogging` default false · CI workflow.
**Tier 1**: WS abuse caps (`WS_MAX_PAYLOAD`, per-connection rate limit, `bufferedAmount` backpressure) ·
notify hardening (per-share registry, connection-derived sender, viewer gate, safe server-derived `Click`) · folder
move/rename/delete handling · `stampEdit` moved to a separate `edits` map (no delete-clobber) ·
createFileProvider in-flight reservation · comment-anchor quote-verify + re-match (no mis-highlight).
**Tier 2**: real-`FileProvider` integration test (fake vault/IDB/WS via esbuild alias) wired into CI ·
real-server WebSocket e2e for convergence, viewer write rejection, restart durability, and revocation ·
mixed-version v1↔v2 manifest migration coverage.
**Tier 3 foundation**: signed per-install identities bind invite links on first use; invite reuse from a
different signed install is rejected before joining the room.
**Tier 4 foundation**: binary attachments sync through content-addressed `/blob` uploads/downloads and
manifest `kind:"binary"` entries; attachment/delete conflict copies are stamped and reviewable from the
history panel.
**Scale foundation**: namespaced shares multiplex manifest + file Yjs rooms over one physical WebSocket
per client/share; server e2e verifies two rooms over two mux sockets; server persistence uses one
dirty-room global save sweep instead of one interval per active room.

**Still open (highest first):** verify the Railway **volume is persistent** + backup env vars are set
(ops, not code) · account-grade identity semantics · true HA storage/fan-out · human device-matrix test.

---

## ⚠️ Deploy-gating note
> **Update:** both gating items below are now **fixed in code** (path-traversal guard; backup support).
> The residual gate is **operational**: confirm the Railway volume is persistent and the backup env vars
> are actually set (`SNAPSHOT_GIT_REMOTE`, `PERSIST_BACKUP_COMMAND`, `OPS_NTFY_TOPIC`). The code now
> defaults `REQUIRE_SNAPSHOT_REMOTE` and `REQUIRE_PERSIST_BACKUP` to true in production, so `/health` fails
> closed until those off-box backups are configured unless that protection is explicitly disabled.

Two findings are exploitable against the **current live system** and should land before the
collaborator set grows via shared links:
1. **Manifest path-traversal → arbitrary file write/RCE** (Tier 0.1) — latent today, not introduced by v1.
2. **Zero off-box backup** (Tier 0.2) — single-volume total-loss risk.

Recommended gate: ship Tier 0 (esp. 0.1, 0.2, 0.3) **before** onboarding more people or widening shares.
The server-side parts of Tier 0/1 are additive + graceful → deploy-first, then client.

---

# Tier 0 — Stop silent data loss & lock the doors (mostly S/M, do first)

### 0.1 — Path-traversal guard on manifest keys (CRITICAL, M)
**Problem.** `toFullPath(relPath) = localFolder + "/" + relPath` (`SyncManager.ts:798-800`) does zero
normalization. Manifest `Y.Map("files")` keys are remote-controlled; `handleManifestChange`
(`SyncManager.ts:314`) and `onManifestSynced` (`:259`) feed them straight into
`ensureFolder(dir)` + `guardedCreate(fullPath)`. An editor-link holder can set a key like
`../../.obsidian/plugins/obsidian-collab/main.js` → every peer overwrites that path on reconcile
→ silent RCE (Obsidian executes plugin `main.js`) or cross-folder corruption outside the share.
**Fix.** Add `safeRelPath(relPath): string | null` in a util:
- reject segments that are `..`, `.`, empty, absolute, contain `:` / backslash / control chars / NUL;
- reject unsupported types (text is `.md`/`.canvas`; attachments are safe-listed binary extensions);
- assert `normalizePath(localFolder + "/" + relPath)` stays within `localFolder + "/"`.
Apply on **both** sides:
- **Write side** — `onFileCreate`/`onFileModify`/rename: only publish keys that pass.
- **Apply side** — `handleManifestChange`/`onManifestSynced`: **skip** (don't create) any entry whose
  key fails; `log("loop","rejected unsafe manifest path", key)`. Never throw.
Use Obsidian's `normalizePath` for the editor; mirror the same guard server-side later (Tier 1.2).
**Verify.** Unit-test `safeRelPath` rejects `../x`, `/etc/x`, `a/../../b`, `..\\b`, `a:b`, `note.exe`,
accepts `a/b/note.md`. Manual: craft a manifest key with `..` on one client (devtools), confirm the
peer logs a rejection and creates nothing outside the share folder.
**Compat.** Pure tightening; legitimate relPaths are unaffected.

### 0.2 — Off-box backup of the durable corpus (CRITICAL, M)
**Problem.** All durable state (`*.yjs`, the snapshot git repo, `share-state.json`,
notify registry) lives only on the single Railway volume. No `git remote`/`push`/S3/rclone anywhere.
Volume corruption / service delete / account lockout destroys every document **and** the recovery net
(deleted-file restore + version history both read this volume).
**Fix.**
- `git remote add origin <private repo>` in `snapshots.ts` init; `git push` (best-effort, logged) after
  each `commitIfChanged`. Use a deploy key / PAT in a Railway secret. Push failures must not block saves.
- Daily `tar`/`rclone` of `$PERSIST_DIR` to S3/R2/Backblaze with N-day rotation (Railway cron or a
  setInterval in-process with jitter). Even daily turns "total irreversible loss" → "lose <24h".
- Write `RECOVERY.md` (how to restore from the remote/bucket into a fresh volume).
**Verify.** Confirm a commit appears in the private remote after an edit; confirm a bucket object lands;
do a dry-run restore into a temp `PERSIST_DIR` and boot the server against it.
**Compat.** Additive; no protocol change.

### 0.3 — `/health` does a real durability check + alert on save failure (HIGH, S)
**Problem.** `/health` (`index.ts:31`) returns static `{status:'ok'}` with no I/O; save/snapshot errors
are `console.error`-only (`persistence.ts`, `snapshots.ts`, `rooms.ts:132`); the working ntfy path
(`notify.ts`) is never used for ops. A full/read-only disk keeps reporting healthy while edits live
**only in RAM** → a later crash/redeploy loses everything since the last good save, silently.
**Fix.**
- In `persistence.ts` track `lastSaveOk`, `lastSaveTs`; expose a getter. Optionally check free disk
  (`fs.statfs`) on a timer.
- `/health` returns **503** when `!lastSaveOk`, when `lastSaveTs` is stale beyond a threshold while
  rooms are active, or when free disk is low. Point `railway.toml healthcheckPath` at `/health` so
  Railway restarts on persistent failure.
- On repeated save/snapshot/commit failure, fire **one** ntfy push (reuse `notify.ts`) to an ops topic
  (env `OPS_NTFY_TOPIC`), de-duped/rate-limited.
**Verify.** `chmod -w $PERSIST_DIR` on a local run → an edit → `/health` flips to 503 and an ntfy push
fires once. Restore perms → recovers.

### 0.4 — Atomic writes for state files + fail-closed parse (HIGH, S)
**Problem.** `share-state.json` (`shareState.ts:32`), the notify registry, and snapshots
(`snapshots.ts:68`) write **in place**. The `.yjs` path already proves the safe `tmp+rename` pattern
(`persistence.ts:54-59`). Worse: `shareState.ts:24-25` resets to `{}` on **any** read/parse error — a
torn write makes the server boot with an empty `minEpoch` map and **silently un-revoke every revoked
share code**.
**Fix.** Factor `atomicWrite(path, data)` (tmp + `fsync` + `rename`) into a shared util; use it for all
three. On parse error in `shareState`/notify-registry, **fail closed**: keep the in-memory cache /
refuse to drop revocations rather than resetting to `{}`; log loudly.
**Verify.** Kill the process mid-write (or write garbage) → confirm the old file is intact and
revocations survive a reboot.

### 0.5 — Corrupt `.yjs` must not deny the whole room (HIGH, S)
**Problem.** `loadState` (`persistence.ts:38`) re-throws any non-ENOENT error, so one truncated `.yjs`
makes `getOrCreateDoc` reject **permanently** — that file is unjoinable forever.
**Fix.** Wrap `Y.applyUpdate` in try/catch: on corruption, rename the bad file aside (`.corrupt-<ts>`),
`console.error` loudly (+ ops ntfy), and start the room from **empty** so connected clients' IndexedDB
re-seeds it via the existing reconcile path.
**Verify.** Truncate a `.yjs` to a few bytes → a client can still join that room; the bad file is moved
aside; content re-seeds from a client that has it.

### 0.6 — git gc / retention on the snapshot repo (HIGH→prevents Tier-0.3 trigger, S/M)
**Problem.** `snapshots.ts` commits every 5 min forever with no `gc`/repack/retention → unbounded loose
objects + working-tree copies fill the fixed volume → **all** saves and commits then fail.
**Fix.** Run `git gc --auto` inside `commitIfChanged`; add a retention/expire policy (squash or drop
commits older than N days, or shallow-keep). Surface free-disk in `/health` (0.3).
**Verify.** Simulate many commits; confirm `.git` size stays bounded after gc.

### 0.7 — Refuse to start on empty/weak SERVER_SECRET in prod (HIGH→S, partial of 1.x)
**Problem.** With no `AUTH_TOKEN`/`SERVER_SECRET` the banner prints `Auth: DISABLED` (`index.ts:147`)
and the server **keeps running wide open**.
**Fix.** In prod (`NODE_ENV==='production'` or a `REQUIRE_AUTH` flag), `process.exit(1)` if
`SERVER_SECRET` is empty or below a min length. Separate the admin-token secret from the
share-derivation secret (distinct env vars) so admin compromise ≠ share compromise.
**Verify.** Boot with empty secret in "prod" → exits non-zero with a clear message.

### 0.8 — Default `debugLogging` to false (S)
**Problem.** `log.ts:9` `DEBUG=true`; `types.ts` default and the `main.ts` migration both default
`debugLogging:true` → every cofounder's console floods with per-keystroke chatter, hurting editor perf
and burying real warnings.
**Fix.** Flip the three defaults to `false`; keep the settings toggle (and a one-click "copy collab
logs" action for loop diagnosis).
**Verify.** Fresh install logs are quiet; toggle on restores chatter.

### 0.9 — Minimal CI gate (S, enabler for Tier 2)
**Problem.** No `.github/`, no server test script. Nothing gates changes to the most regression-prone
files before they reach live vaults.
**Fix.** GitHub Actions: `npm ci && npm test` in `plugin/`, `tsc -noEmit` in both packages, required on
PRs. (Real wiring-level tests come in Tier 2.)
**Verify.** A PR that breaks a unit test or typecheck is blocked.

---

# Tier 1 — Plug abuse vectors & convergence races (M, security + data-integrity)

### 1.1 — WS resource caps + backpressure (HIGH, M)
**Problem.** `WebSocketServer` has no `maxPayload` (`index.ts:82`) → ws's ~100MB default; `handleMessage`
(`rooms.ts:176`) applies every update with no size/op/rate cap, then persists it forever and rebroadcasts;
`send()` (`rooms.ts:159`) has no `bufferedAmount` backpressure; `getOrCreateDoc` makes a room for **any**
name. One authed editor can bloat the volume/git irreversibly, open unbounded rooms, or OOM the box via a
slow peer.
**Fix.** Set `wss` `maxPayload` ~1–2MB; per-connection inbound token-bucket; reject updates that push a doc
past N MB; in `send()` drop/cap and close sockets whose `bufferedAmount` exceeds a threshold; coalesce
awareness to ~10/s per room.
**Verify.** Push a 5MB update → rejected; flood messages → rate-limited; a stalled reader → its socket is
closed instead of growing server memory.

### 1.2 — Enforce room ↔ connection share binding on every message (HIGH, S/M)
**Problem.** Post-upgrade, a message handler doesn't re-check that the room's shareId matches the
connection's `collabShareId`. Combined with the single master secret (1.5), a token holder can touch other
shares' rooms.
**Fix.** On every `MESSAGE_SYNC`/`AWARENESS`/`NOTIFY`, assert `shareIdOf(room) === conn.collabShareId`
(or that the conn is authorized for that room); drop otherwise. Also mirror `safeRelPath` (0.1)
server-side in `snapshots.parseFileRoom` and history paths.
**Verify.** A client authed for share A that forges a frame to a share-B room is dropped + logged.

### 1.3 — Notify hijack + Click-URL abuse (HIGH, M)
**Problem.** `registerTopic(uid, topic)` (`rooms.ts:219`, `notify.ts:30`) trusts the **client-supplied uid**
with no role/share check; the registry is one **global** uid→topic map; `notify.ts:101` forwards the
client `click` verbatim into the ntfy `Click` header. uids are public (awareness/comments). Any client can
register under a victim's uid to **intercept** their @mention pushes, forge senders, or push a notification
whose tap opens `obsidian://collab-add?code=<attacker>` to silently re-home the victim.
**Fix.** Derive sender uid from the **authed connection**, not the frame; only allow `registerTopic` for the
conn's own identity; **namespace the registry per shareId**; gate NOTIFY/TOPIC_REGISTER on role
editor/commenter; rate-limit per-connection/IP (not per client-controlled `fromUid`). Whitelist the `Click`
scheme/host (or drop `Click`); strip control chars.
**Verify.** A client cannot register a topic under another uid; a forged Click with a non-whitelisted scheme
is stripped; safe note paths get server-derived `obsidian://open` links; cross-share mention delivery is
blocked.

### 1.4 — `stampEdit` LWW clobbering a concurrent delete/rename (MEDIUM, M)
**Problem.** `stampEdit` (`SyncManager.ts:122-123`) reads `cur` outside a transaction then sets the **whole**
entry object. Y.Map values are opaque → LWW on the entire entry. A typing user's 3s-debounced stamp can land
after a concurrent delete and **erase the tombstone**, silently undeleting the file on all clients (and the
mtime-resurrection guard can't help — no tombstone remains).
**Fix.** Either (a) store volatile fields (`lastEditedBy/At`) in a **separate nested `Y.Map` per file** so
they merge independently of the `exists`/delete lifecycle field, or (b) make `stampEdit` re-read **inside a
`transact`** and bail if `!cur.exists` (delete/rename always win). Also fix the `createFileProvider`
has-check/set race by reserving the slot synchronously with a `Map<string, Promise<FileProvider>>`.
**Verify.** Headless: interleave a debounced stamp with a delete on two docs → the tombstone survives; no
duplicate providers under rapid create.

### 1.5 — Folder rename/move/delete loses every child (HIGH, M)
**Problem.** `main.ts:99-100` forwards only `file instanceof TFile`. Obsidian fires **one** `TFolder` rename
event for a folder move (not per-child), so `onFileRename` never runs for the children. Dragging `specs/` →
`archive/specs/` leaves old relPaths `exists:true` (peers re-create empty ghosts) while new paths are adopted
as **new** creates with fresh fileIds — losing comment + version lineage and diverging permanently. Teams
reorganize by dragging folders constantly.
**Fix.** Add a `TFolder` branch to the rename handler: enumerate descendant `TFile`s and route each through
`onFileRename(child, oldChildPath)` via prefix substitution; guard against double-processing if Obsidian
later emits child events. Same for `TFolder` delete.
**Verify.** Move a folder with 3 commented notes → peers see the move, content + comments + history intact,
no ghosts at the old paths.

### 1.6 — Comment anchors mis-highlight after deletes (MEDIUM, M)
**Problem.** Server runs file docs with `gc:true` (`rooms.ts:28`); anchors are relative positions with
default assoc; `resolveAnchor` only flags `lost` when offsets collapse equal (`CommentStore.ts:88-98`). When
commented text is deleted and editing continues, a GC'd anchor resolves FROM→0 while TO stays live →
`{from:0,to:40,lost:false}` → the comment visibly highlights unrelated text at the file start, with no
"orphaned" indicator. Over weeks this is the **default** fate of any comment whose text gets deleted.
**Fix.** Run file Y.Docs with `gc:false` on the server (git snapshots already cap on-disk growth; periodically
compact via `encodeStateAsUpdate` round-trip). Store anchors with explicit assoc (`-1` from, `+1` to); treat
`from===0 && quote not found at [from,to]` as lost; add a quote-rematch re-anchor fallback.
**Verify.** Comment a paragraph, delete it, keep editing → the comment shows as orphaned, never highlights
unrelated text.

---

# Tier 2 — Real test coverage & operability (L/M)

### 2.1 — Wiring-level tests on the REAL FileProvider/SyncManager (HIGH, L)
**Problem.** No test imports `FileProvider`/`SyncManager`; `loop-sim.test.mjs` reimplements the loop in its
own `Client` class. The hardened logic (echo re-entrancy, stale-echo ring, tombstone resurrection, rename
Y.Doc transfer) is the most regression-prone code and is invisible to tests — a mis-wired observer or a
forgotten `echo.mark` passes every current test and ships to live vaults.
**Fix.** Introduce a `VaultLike`/`AppLike` seam (interface for the `app.vault` methods used) + an in-memory
fake vault adapter; drive the **real** `FileProvider`/`SyncManager` through loop / rename / delete / resurrect
/ offline-reconcile scenarios. Stub `IndexeddbPersistence` and the WS provider with in-memory fakes.
**Verify.** The suite reproduces v1's original bugs when the guards are removed (red), green with them in.

### 2.2 — Automated multi-client e2e (implemented)
**Status.** `server/test/ws-e2e.test.mjs` spins a temp-`PERSIST_DIR` server and drives protocol-level
clients against the real relay. It asserts two-editor convergence, **viewer write must not persist**,
restart durability, and revoked-epoch → 4003 close. CI runs it after the server build.

### 2.3 — Mixed-version v1↔v2 manifest migration test (implemented)
**Problem.** The highest-risk real-world window is cofounders upgrading at different times (old client writes
entries without `fileId`; new client migrates). No test covers it.
**Status.** Headless coverage now checks concurrent v1→v2 migration plus an old-shaped create arriving
after a new-schema client has joined. It asserts migration idempotence, old/new convergence, and no loss of
unknown v2 fields during old-client round trips.
**Verify.** `plugin/test/manifest.test.mjs` covers the version boundary.

### 2.4 — Structured logging + cumulative metrics + alerting (implemented foundation; ops follow-ups remain)
**Problem.** Server logs are `console.*` only; `/metrics` is in-memory (lost on restart, no series).
**Status.** Structured redacted JSON logs now cover relay joins/leaves, rejected writes, mux room
rejections, rate limits, backpressure closes, suspicious updates, awareness rejections, and opt-in client
errors. `/metrics` now includes cumulative counters for save/snapshot failures, disconnects, revocations,
rejected writes/paths, rejected awareness, rate limiting, backpressure closes, send failures, client
errors, and mux room rejections, alongside live room/runtime state.
**Remaining.** Point stdout/stderr at a retained drain in production and add explicit threshold alerts if
the hosted platform cannot alert on `/health`/`/metrics`.
**Verify.** Unit/e2e coverage checks metric counter behavior and `/metrics.counters` increments on real
clientlog, blob rejection, and revocation paths.

### 2.5 — Resurrection no longer relies on wall-clock (implemented foundation; logical-clock follow-up remains)
**Problem.** `shouldResurrect` compares cross-device wall-clock `mtime` vs `deletedAt` (skew-biased toward
keep). Fine as a safety bias, but ambiguous cases can surprise.
**Status.** Implemented the deterministic fallback: ambiguous clock-skew cases now create a visible
`(... delete conflict ...).md`/attachment copy before the remote tombstone is applied. Clear edits after the
delete still resurrect, old local copies delete, and rename tombstones still delete because the content moved
to the new path. Mutation-stamped tombstones now avoid cross-device resurrection from `mtime` alone: a
same-device tombstone deletes, while a different-device apparent-newer local copy becomes a conflict copy.
Old/no-provenance tombstones retain the legacy safety behavior. The pure `tombstoneLocalDecision` helper
covers these branches headlessly.
**Remaining.** Replace the remaining old-client fallback with a full logical/same-clock marker (e.g., an edit
Lamport/seq on the file doc) when the file-doc protocol is revised.
**Verify.** Unit coverage asserts resurrect/delete/conflict-copy branches. A full two-client skew simulation
is still needed.

### 2.6 — Stop swallowing client errors (implemented foundation)
**Problem.** Many `.catch(()=>{})` hide lifecycle failures from the user and from us.
**Status.** Implemented opt-in client error telemetry: plugin `err(...)` rows are locally persisted as before
and, when enabled, POSTed to `/clientlog` using normal share authentication. The server caps request size,
re-normalizes/redacts the payload, and emits a structured `client.error` row. Lifecycle catches already moved
under the `err` namespace feed this path.
**UX.** User-triggered reconnect/force-resync and share startup failures now emit targeted Notices while
best-effort background cleanup stays diagnostics-only.
**Verify.** Unit coverage checks plugin telemetry POST shape and server-side client-log redaction. A full
live-server provider-failure drill is still needed.

---

# Tier 3 — Scale ceiling & HA (XL, architectural — gate the rest of scale on this)

### 3.1 — Multiplex to ONE socket per client per share (implemented foundation)
**Status.** Namespaced shares now use a multiplexed WebSocket endpoint (`@<shareId>:__mux__`) that carries
manifest + file-room Yjs frames over one authenticated physical socket per client/share. Internally the
server still keeps one `WSSharedDoc` per room and evicts it on last disconnect, so persistence/history stay
unchanged. Legacy shares keep the old per-room socket transport. Real-server e2e verifies two text rooms
syncing through two mux sockets.
**Remaining.** True HA storage/fan-out.

### 3.2 — Server-side share minting / per-share key isolation (implemented foundation; follow-ups remain)
**Status.** Implemented the foundation: `/share/create` mints new shares with `SHARE_MINT_TOKEN`, returns
only a scoped editor key plus per-share `ownerKey`, and keeps `SERVER_SECRET` on the server. `/share/link`
and `/share/revoke` require the owner key, so a leaked client config can mint/revoke only that share.
`/share/invite` adds per-recipient invite ids + optional expiry; `/share/invite/revoke` revokes one invite
and closes only its live sockets. Invite links are bound to the first signed per-install identity that uses
them, and a different signed identity is rejected before joining. Secret rotation windows are supported with
`*_PREVIOUS` env vars: old tokens verify during the grace window, while all newly minted share/link/invite
tokens use the current primary secrets. The old client-side HMAC path remains as a legacy fallback for old
servers.
**Remaining.** Account-grade identity semantics.
**Verify.** Server auth/share-state tests and real-server e2e cover role/owner/invite separation, expiry,
revoked-owner rejection, live invite revocation, and signed invite identity binding.

### 3.3 — Memory-pressure room eviction + process tuning (L)
**Status.** `closeConn` now uses a per-connection room back-reference instead of scanning every active room,
and aborted joins clean up the empty room they loaded. `/health` and `/metrics` now expose runtime memory
pressure; Docker defaults `NODE_OPTIONS=--max-old-space-size=384`, and Railway already uses `/health` plus
`ON_FAILURE` restart policy.
**Remaining.** True LRU room eviction is mostly moot while rooms close on last disconnect; revisit only if
we intentionally add an idle room cache or need to shed connected rooms under severe pressure.

### 3.4 — Move durable state off the local volume for HA (XL)
**Fix.** Postgres / y-redis backing so stateless replicas can run behind Railway (HA + zero-downtime deploys);
a shared relay (Redis/NATS) for cross-instance fan-out. Unlocks horizontal scale beyond one box.

### 3.5 — Per-recipient revocable invites + expiring codes (implemented)
**Status.** Invite codes include role, epoch, invite id, and optional expiry in the HMAC. The server stores
invite state, rejects expired/revoked invites, and can revoke one invite without epoch-bumping everyone.
A persisted audit log of joins/revokes/security rejections also exists.

---

# Tier 4 — Feature parity (L/XL, after robustness)

### 4.1 — Binary/attachment sync (HIGH user value, L/XL)
**Status.** Implemented the foundation: Markdown and `.canvas` text files still sync through the Y.Text
path; safe-listed image/PDF/audio/video attachments now upload to `/blob` as content-addressed SHA-256
objects under `$PERSIST_DIR/blobs` or an S3-compatible object store (`BLOB_STORE=s3`), with manifest
`kind:"binary"`/`blobHash`/`blobSize` metadata. Editors can upload; any valid role can download. Peers
download and write the attachment when the manifest entry appears. Server tests and real-server e2e cover
blob validation, editor upload, viewer download, viewer upload rejection, filesystem storage, and
S3/R2-compatible storage. Orphan blob GC can scan persisted manifests, keep referenced tombstone blobs for
recovery, dry-run by default through `/admin/blob-gc`, and optionally run on an interval against the
configured blob store.
Live binary apply now keeps and republishes a clearly newer local attachment instead of overwriting it with
an older remote blob. Ambiguous same-time updates inside the skew window create a visible
`(... binary conflict ...).ext` sibling before the original path is updated to the remote blob, which gives
attachment collisions the same recovery shape as delete-vs-edit conflicts.
**Status update.** Conflict copies now carry structured `conflict*` manifest metadata and the history panel
lists them with Open actions, covering delete/edit and attachment skew cases.
**Remaining.** Human mobile testing with real images/PDFs, and a richer binary diff/preview workflow if that
becomes worth the complexity.

### 4.2 — Inline / side-by-side version diff (implemented)
**Status.** History preview is no longer only a raw 4000-char dump: the sidebar can compare a saved
version with the current local note, render inline or side-by-side line diffs, and restore either the
whole version or one selected change hunk. Hunk restore refuses to apply if the note changed since the
diff loaded.
**Remaining.** A full editor-grade compare view would still be nicer for very large files, but the main
diff workflow is covered in the sidebar.

### 4.3 — @mention autocomplete + working deep-link (implemented foundation)
**Status.** Comment inputs offer `@` autocomplete from the share roster, quoted full-name mentions are
parsed reliably, and mention pushes include a server-derived `obsidian://open?path=...` click target for
sanitized Markdown/Canvas paths.
**Remaining.** A richer CM6 editor suggest could be added later if comments move into the editor surface;
the current sidebar and add-comment modal paths are covered.

### 4.4 — Comment notifications beyond @mention + unread inbox (implemented)
**Status.** Thread authors now get push notifications when someone else replies to, resolves, or reopens
their comment, without duplicating an explicit @mention notification. A cross-file unread comment inbox
tracks per-device read timestamps and opens the target note/thread.

### 4.5 — Link integrity + follow-presence (implemented)
**Status.** Presence avatars in the file tree and workspace tab headers can open a collaborator's active
local file. The active-editor facepile still jumps to a peer's caret in the same file. Remote rename now
repairs `[[wikilinks]]`/embeds in synced Markdown notes as a CRDT edit, preserving aliases/subpaths and
skipping code.

### 4.6 — Join-by-code UX (implemented)
Deep-links open the join modal with the code pre-filled. New share codes carry an optional label, and
the join flow suggests a friendly `Shared/<label>` folder plus editable label instead of silently dumping
into `Shared/<rawid>`.

### 4.7 — Nested/overlapping shares + suggesting mode (XL, deferred)
Most-specific-wins precedence for overlapping shares (currently hard-blocked); track-changes/suggesting mode
+ export-clean (explicitly deferred in v1).

---

## Cross-cutting

- **Backward compatibility.** Tier 0/1 client changes are tightening/additive; manifest stays schema-v2.
  Old clients keep working (ignore unknown fields). The legacy share is unaffected.
- **Rollout order.** Server-side bits of Tier 0 (`/health`, atomic writes, corrupt-file survival, gc, backup,
  secret-on-start) are additive + graceful → **deploy first**, then ship the client (path-traversal guard,
  folder-rename, stamp fix), then human-test mobile.
- **Test-first for the convergence fixes.** 1.4/1.5/1.6 should land with the Tier-2 fake-vault harness so the
  fix and its regression test arrive together.
- **Effort legend.** S ≈ hours, M ≈ a day, L ≈ a few days, XL ≈ a week+ / architectural.

## Recommended sequencing
**Tier 0 (security + durability quick wins) → deploy + install → Tier 1 (abuse + races, test-backed) →
Tier 2 (real test harness + CI + ops) → Tier 3 (scale/HA, only when file/collaborator counts demand it) →
Tier 4 (features, once trusted).** Each tier is independently shippable; nothing below Tier 3 requires the
multiplexing rewrite.
