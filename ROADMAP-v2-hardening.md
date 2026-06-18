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
delete-vs-edit resurrection, shared `applyRemoteTombstone` · offline IDB-base reconcile + "N pending"
indicator · mobile-safe presence, clipboard fallbacks, multi-instance detection · atomic `.yjs` saves,
graceful SIGTERM, active revocation (epoch + 4003 close), per-device presence, Tier-2 per-share HMAC.

## ✅ Completed since this roadmap was written
**Tier 0** (durability + security quick wins): path-traversal guard (`safeRelPath`, both sides) ·
off-box backups (`SNAPSHOT_GIT_REMOTE` git push + `PERSIST_BACKUP_COMMAND` archive) · real `/health`
durability checks + 503 + `OPS_NTFY_TOPIC` alerts · atomic state writes + fail-closed parse ·
corrupt-`.yjs` survival · `git gc` · refuse-to-start on weak secrets (`REQUIRE_AUTH`, `ADMIN_SECRET`,
`MIN_SECRET_LENGTH`) · `debugLogging` default false · CI workflow.
**Tier 1**: WS abuse caps (`WS_MAX_PAYLOAD`, per-connection rate limit, `bufferedAmount` backpressure) ·
notify hardening (per-share registry, connection-derived sender, viewer gate, dropped `Click`) · folder
move/rename/delete handling · `stampEdit` moved to a separate `edits` map (no delete-clobber) ·
createFileProvider in-flight reservation · comment-anchor quote-verify + re-match (no mis-highlight).
**Tier 2**: real-`FileProvider` integration test (fake vault/IDB/WS via esbuild alias) wired into CI.

**Still open (highest first):** verify the Railway **volume is persistent** + backup env vars are set
(ops, not code) · per-recipient signed identities/audit log · socket multiplexing / scale ceiling
(Tier 3.1) · binary/attachment sync (Tier 4.1) · hunk-level version restore · human device-matrix test.

---

## ⚠️ Deploy-gating note
> **Update:** both gating items below are now **fixed in code** (path-traversal guard; backup support).
> The residual gate is **operational**: confirm the Railway volume is persistent and the backup env vars
> are actually set (`SNAPSHOT_GIT_REMOTE`, `PERSIST_BACKUP_COMMAND`, `OPS_NTFY_TOPIC`).

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
- reject non-text types (currently `.md` and `.canvas`);
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
is stripped; cross-share mention delivery is blocked.

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

### 2.2 — Automated multi-client e2e (HIGH, L)
**Fix.** Promote `ws-sync.test.mjs` to a CI job: spin a temp-`PERSIST_DIR` server, run cross-process clients
asserting two-editor convergence, **viewer write must not persist**, reconnect-durability, and
revoked-epoch → 4003 close.
**Verify.** Job runs in CI and fails if any invariant breaks.

### 2.3 — Mixed-version v1↔v2 manifest migration test (MEDIUM, M)
**Problem.** The highest-risk real-world window is cofounders upgrading at different times (old client writes
entries without `fileId`; new client migrates). No test covers it.
**Fix.** Headless test: old-shaped and new-shaped entries syncing both directions converge; migration is
idempotent; old clients ignore unknown fields.
**Verify.** Asserted convergence + no field loss across the version boundary.

### 2.4 — Structured logging + cumulative metrics + alerting (MEDIUM, M)
**Problem.** Server logs are `console.*` only; `/metrics` is in-memory (lost on restart, no series).
**Fix.** Structured per-connection logs (uid, room, epoch, role) to a retained drain; cumulative counters
(`save_failures`, `disconnects`, `revocations`, `rejected_paths`, `rate_limited`) on `/metrics`; a basic
alert (reuse ops ntfy from 0.3) on threshold breach.
**Verify.** A loop or save-failure is diagnosable from logs/metrics without a debugger.

### 2.5 — Resurrection no longer relies on wall-clock (LOWER, L)
**Problem.** `shouldResurrect` compares cross-device wall-clock `mtime` vs `deletedAt` (skew-biased toward
keep). Fine as a safety bias, but ambiguous cases can surprise.
**Fix.** Prefer a logical/same-clock marker (e.g., an edit lamport/seq on the file doc) or, on ambiguity,
surface a **conflict copy** (`note (resolved conflict).md`) instead of a silent keep/delete.
**Verify.** Concurrent delete+edit under clock skew yields a deterministic, user-visible outcome.

### 2.6 — Stop swallowing client errors (MEDIUM, M)
**Problem.** Many `.catch(()=>{})` hide lifecycle failures from the user and from us.
**Fix.** Opt-in client error telemetry: POST top-level lifecycle failures to a `/clientlog` endpoint; keep
intentional best-effort catches but log them under the `err` namespace.
**Verify.** A simulated provider failure surfaces a Notice + a server-side log entry.

---

# Tier 3 — Scale ceiling & HA (XL, architectural — gate the rest of scale on this)

### 3.1 — Multiplex to ONE socket per client per share (XL)
**Problem.** `onManifestSynced` opens a `FileProvider` (its own WS socket) for **every** manifest entry on
connect; the server holds one in-memory `WSSharedDoc` per room, evicted only at zero connections, with no LRU
or memory ceiling. A 1,000-note share × 4 cofounders = 4,000 sockets + 1,000 resident docs for an idle vault;
mobile dials 1,000 sockets at once (Alpine FD ~1024 blows first); every redeploy is a reconnect
thundering-herd that can trip the 30s healthcheck → self-inflicted outage that worsens as the vault grows.
**Fix.** Multiplex: one socket per client per share, tunnel per-file Y.Doc frames over it with room-id as a
frame field (y-sweet/Hocuspocus model). Interim, cheaper: **lazy-open** file rooms only for open/recently-
active files + the manifest; add client connect jitter; replace per-room 60s save timers + per-conn 30s pings
with a per-room dirty-flag **global sweep**.
**Verify.** A 1,000-file share opens O(1) sockets/client; redeploy reconnect is smooth; idle memory bounded.

### 3.2 — Server-side share minting / per-share key isolation (implemented foundation; follow-ups remain)
**Status.** Implemented the foundation: `/share/create` mints new shares with `SHARE_MINT_TOKEN`, returns
only a scoped editor key plus per-share `ownerKey`, and keeps `SERVER_SECRET` on the server. `/share/link`
and `/share/revoke` require the owner key, so a leaked client config can mint/revoke only that share. The
old client-side HMAC path remains as a legacy fallback for old servers.
**Remaining.** Add key-rotation windows, per-recipient/expiring invites, and an audit log (see 3.5).
**Verify.** Server auth tests cover role/owner key separation and revoked-owner rejection.

### 3.3 — Memory-pressure room eviction + process tuning (L)
**Fix.** LRU room eviction under a memory ceiling (persist + drop idle rooms); `--max-old-space-size`;
Railway `restartPolicy` tuning; replace `closeConn`'s O(rooms) scan with a per-connection back-reference.

### 3.4 — Move durable state off the local volume for HA (XL)
**Fix.** Postgres / y-redis backing so stateless replicas can run behind Railway (HA + zero-downtime deploys);
a shared relay (Redis/NATS) for cross-instance fan-out. Unlocks horizontal scale beyond one box.

### 3.5 — Per-recipient revocable invites + expiring codes + audit log (M)
**Fix.** Fold `exp` into the HMAC for expiring share codes; per-recipient invites that revoke individually
(not just epoch-bump-everyone); a persisted audit log of joins/revokes/cross-share attempts.

---

# Tier 4 — Feature parity (L/XL, after robustness)

### 4.1 — Binary/attachment sync (HIGH user value, L/XL)
Markdown and `.canvas` text files now sync through the existing Y.Text path. Embedded images/PDFs and
other binary assets still silently never reach peers and render as broken links — the biggest
visible-correctness gap. Sync binaries via content-addressed blobs (hash → `blob:` room or object store),
referenced from the manifest; lazy-fetch on demand.

### 4.2 — Inline / side-by-side version diff (M)
History preview is no longer only a raw 4000-char dump: the sidebar can compare a saved version with
the current local note and render an inline line diff. Still open: hunk-level restore and a richer
side-by-side editor view.

### 4.3 — @mention autocomplete + working deep-link (M)
CM6 `EditorSuggest` from the share roster; the push's tap opens the file. Today mentions need exact
display-name spelling and tap nowhere.

### 4.4 — Comment notifications beyond @mention + unread inbox (M)
Notify thread author on reply/resolve; a cross-file unread-comment inbox. Async review is currently broken
across devices.

### 4.5 — Link integrity + follow-presence (M)
Rewrite `[[wikilinks]]`/embeds in sibling notes on remote rename; presence-click opens a peer's active file
(follow beyond same-file).

### 4.6 — Join-by-code UX (S/M)
Deep-link opens a pre-filled join modal; prompt for a friendly folder + label instead of dumping into
`Shared/<rawid>`.

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
