# ObsidianSync Recovery

This service persists all durable state under `PERSIST_DIR` (default `./collab-data`):

- `*.yjs` room state files
- `share-state.json` revocation watermarks
- `notify-registry.json`
- `audit.jsonl`
- `blobs/` content-addressed attachment files
- `snapshots/` git repo with human-readable note history

The bundled Git full-corpus backup excludes retained logs/audit JSONL files and `snapshots/`; snapshot
history is pushed separately by `SNAPSHOT_GIT_REMOTE`.

## Off-box backup setup

Set at least one off-box destination in Railway:

- `SNAPSHOT_GIT_REMOTE`: private git remote for `collab-data/snapshots`
- `SNAPSHOT_GIT_BRANCH`: branch to push, default `main`
- `SNAPSHOT_GIT_SSH_KEY`: SSH deploy private key with write access to the git remote. It can be stored
  as a real multiline Railway secret or with escaped `\n` newlines.
- `PERSIST_BACKUP_COMMAND`: daily full-corpus backup command. The process exports `PERSIST_DIR`.

Git-only full-corpus backup using the bundled script:

```sh
PERSIST_BACKUP_COMMAND='sh scripts/git-full-backup.sh'
PERSIST_BACKUP_GIT_BRANCH=backups
```

`PERSIST_BACKUP_GIT_REMOTE` defaults to `SNAPSHOT_GIT_REMOTE`; set it only if the archive branch should
live in another private repo.

Example backup command:

```sh
tar -C "$PERSIST_DIR" -czf /tmp/obsidian-sync-backup.tgz . && rclone copy /tmp/obsidian-sync-backup.tgz r2:obsidian-sync-backups/$(date -u +%Y-%m-%dT%H-%M-%SZ).tgz
```

Set `OPS_NTFY_TOPIC` so backup, save, corrupt-state, and snapshot failures page you once per failure class.

## Blob garbage collection

Attachment blobs are content-addressed under `blobs/<share>/<hash-prefix>/<hash>`. Deleted binary files
remain recoverable because their manifest tombstones still reference the blob hash.

Preview orphan cleanup:

```sh
curl -X POST "$BASE_URL/admin/blob-gc?dryRun=true" \
  -H "Authorization: Bearer $ADMIN_SECRET"
```

Delete unreferenced blobs older than the configured grace window:

```sh
curl -X POST "$BASE_URL/admin/blob-gc?dryRun=false" \
  -H "Authorization: Bearer $ADMIN_SECRET"
```

Set `BLOB_GC_INTERVAL_MS` to run this automatically; `BLOB_GC_GRACE_MS` defaults to one day.

## Restore from full-corpus backup

1. Stop the Railway service or deploy a fresh service with an empty volume.
2. Download the newest known-good archive.
3. Extract it into the new volume's `PERSIST_DIR`:

```sh
mkdir -p "$PERSIST_DIR"
tar -C "$PERSIST_DIR" -xzf obsidian-sync-backup.tgz
```

4. Start the service and check `GET /health`.

## Restore only snapshot history

If the live `.yjs` corpus is intact but `snapshots/` was lost:

```sh
mkdir -p "$PERSIST_DIR/snapshots"
git clone --branch "${SNAPSHOT_GIT_BRANCH:-main}" "$SNAPSHOT_GIT_REMOTE" "$PERSIST_DIR/snapshots"
```

Snapshot history is recovery evidence, not the primary sync state. Prefer a full-corpus restore after volume loss.
