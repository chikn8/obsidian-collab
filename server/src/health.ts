import { getBackupHealth } from "./backups.js";
import { getBlobStorageHealth } from "./blobs.js";
import { getLogDrainHealth } from "./logging.js";
import { getOpsAlertHealth } from "./notify.js";
import { getPersistenceHealth } from "./persistence.js";
import { getRuntimeHealth } from "./runtime.js";
import { getShareStateHealth } from "./shareState.js";
import { getSnapshotsHealth } from "./snapshots.js";

export async function collectServerHealth() {
  const [persistence, snapshots, runtime] = await Promise.all([
    getPersistenceHealth(),
    Promise.resolve(getSnapshotsHealth()),
    Promise.resolve(getRuntimeHealth()),
  ]);
  const shareState = getShareStateHealth();
  const backups = getBackupHealth();
  const blobs = getBlobStorageHealth();
  const logDrain = getLogDrainHealth();
  const opsAlerts = getOpsAlertHealth();
  const ok =
    persistence.ok &&
    snapshots.ok &&
    shareState.ok &&
    backups.ok &&
    runtime.ok &&
    blobs.ok &&
    opsAlerts.ok &&
    logDrain.ok !== false;

  return {
    status: ok ? "ok" : "degraded",
    service: "obsidian-collab-server",
    version: "0.2.0",
    persistence,
    snapshots,
    shareState,
    backups,
    blobs,
    runtime,
    logDrain,
    opsAlerts,
  };
}
