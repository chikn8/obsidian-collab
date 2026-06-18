# ObsidianSync Recovery

This service persists all durable state under `PERSIST_DIR` (default `./collab-data`):

- `*.yjs` room state files
- `share-state.json` revocation watermarks
- `notify-registry.json`
- `snapshots/` git repo with human-readable note history

## Off-box backup setup

Set at least one off-box destination in Railway:

- `SNAPSHOT_GIT_REMOTE`: private git remote for `collab-data/snapshots`
- `SNAPSHOT_GIT_BRANCH`: branch to push, default `main`
- `PERSIST_BACKUP_COMMAND`: daily full-corpus backup command. The process exports `PERSIST_DIR`.

Example backup command:

```sh
tar -C "$PERSIST_DIR" -czf /tmp/obsidian-sync-backup.tgz . && rclone copy /tmp/obsidian-sync-backup.tgz r2:obsidian-sync-backups/$(date -u +%Y-%m-%dT%H-%M-%SZ).tgz
```

Set `OPS_NTFY_TOPIC` so backup, save, corrupt-state, and snapshot failures page you once per failure class.

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
