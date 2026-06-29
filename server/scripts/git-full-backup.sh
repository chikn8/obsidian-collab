#!/bin/sh
set -eu

: "${PERSIST_DIR:?PERSIST_DIR is required}"

REMOTE="${PERSIST_BACKUP_GIT_REMOTE:-${SNAPSHOT_GIT_REMOTE:-}}"
BRANCH="${PERSIST_BACKUP_GIT_BRANCH:-backups}"
WORK_DIR="${PERSIST_BACKUP_WORK_DIR:-/tmp/obsidian-collab-full-backup}"

if [ -z "$REMOTE" ]; then
  echo "PERSIST_BACKUP_GIT_REMOTE or SNAPSHOT_GIT_REMOTE is required" >&2
  exit 2
fi

rm -rf "$WORK_DIR"
if ! git clone --depth 1 --branch "$BRANCH" "$REMOTE" "$WORK_DIR"; then
  rm -rf "$WORK_DIR"
  git clone --depth 1 "$REMOTE" "$WORK_DIR"
  (
    cd "$WORK_DIR"
    git checkout --orphan "$BRANCH"
    git rm -rf . >/dev/null 2>&1 || true
  )
fi

cd "$WORK_DIR"
git config user.name "${PERSIST_BACKUP_GIT_USER_NAME:-ObsidianSync}"
git config user.email "${PERSIST_BACKUP_GIT_USER_EMAIL:-sync@obsidian.local}"

git checkout --orphan backup-next
git rm -rf . >/dev/null 2>&1 || true
find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +

tar -C "$PERSIST_DIR" \
  --exclude="./snapshots" \
  --exclude="./snapshots/*" \
  --exclude="*.jsonl" \
  --exclude="*.jsonl.*" \
  --exclude="*.log" \
  --exclude="*.log.*" \
  --exclude="*.tmp" \
  --exclude=".*.tmp" \
  -cf - . | tar -xf -

# Snapshot note history is pushed separately to SNAPSHOT_GIT_BRANCH. Retained
# logs/audit can exceed GitHub's single-file limit and are not required to
# restore the sync corpus.
rm -rf snapshots
find . -type f \( -name "*.jsonl" -o -name "*.jsonl.*" -o -name "*.log" -o -name "*.log.*" -o -name "*.tmp" \) -delete
mkdir -p .backup-meta
date -u "+%Y-%m-%dT%H:%M:%SZ" > .backup-meta/latest.txt

git add -A
if git diff --cached --quiet; then
  echo "[backup] no full-corpus changes"
else
  git commit -m "Full backup $(date -u "+%Y-%m-%dT%H:%M:%SZ")"
fi
git push --force origin "HEAD:$BRANCH"
