import { collectServerHealth } from "./health.js";
import { logEvent } from "./logging.js";
import { alertOps } from "./notify.js";

const DEFAULT_PROD_INTERVAL_MS = 60_000;

let timer: ReturnType<typeof setInterval> | null = null;

export function defaultHealthAlertIntervalMs(): number {
  const raw = process.env.HEALTH_ALERT_INTERVAL_MS;
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  }
  return process.env.NODE_ENV === "production" ? DEFAULT_PROD_INTERVAL_MS : 0;
}

export function startHealthMonitor(options: {
  intervalMs?: number;
  collect?: () => Promise<Record<string, any>>;
  alert?: (key: string, title: string, body: string) => Promise<void>;
} = {}): boolean {
  if (timer) return true;
  const intervalMs = options.intervalMs ?? defaultHealthAlertIntervalMs();
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return false;

  const collect = options.collect || collectServerHealth;
  const alert = options.alert || alertOps;
  const run = () => {
    void checkHealthOnce(collect, alert);
  };
  timer = setInterval(run, intervalMs);
  timer.unref?.();
  run();
  logEvent("info", "health.monitor_started", { intervalMs });
  return true;
}

export function stopHealthMonitor(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  logEvent("info", "health.monitor_stopped");
}

export async function checkHealthOnce(
  collect: () => Promise<Record<string, any>> = collectServerHealth,
  alert: (key: string, title: string, body: string) => Promise<void> = alertOps
): Promise<boolean> {
  try {
    const health = await collect();
    const degraded = degradedHealthComponents(health);
    if (degraded.length === 0) return true;
    const body = healthAlertBody(health, degraded);
    logEvent("warn", "health.degraded", { degraded });
    await alert("health-degraded", "ObsidianSync health degraded", body);
    return false;
  } catch (e: any) {
    const message = String(e?.message || e);
    logEvent("error", "health.check_failed", { error: message });
    await alert("health-check-failed", "ObsidianSync health check failed", message);
    return false;
  }
}

export function degradedHealthComponents(health: Record<string, any>): string[] {
  const out: string[] = [];
  for (const key of ["persistence", "snapshots", "shareState", "backups", "blobs", "runtime", "logDrain", "opsAlerts"]) {
    const component = health?.[key];
    if (component && component.ok === false) out.push(key);
  }
  return out;
}

export function healthAlertBody(health: Record<string, any>, degraded = degradedHealthComponents(health)): string {
  const lines = [
    `status=${health?.status || "unknown"}`,
    `degraded=${degraded.join(",") || "unknown"}`,
  ];
  for (const key of degraded) {
    const component = health?.[key] || {};
    const reason =
      component.lastError ||
      component.error ||
      component.reason ||
      component.lastSaveError ||
      component.lastSnapshotWriteError ||
      component.lastBackupError ||
      component.lastCommitError ||
      component.lastPushError ||
      (component.required && !component.configured ? "required but not configured" : "") ||
      JSON.stringify(component).slice(0, 180);
    lines.push(`${key}: ${reason}`);
  }
  return lines.join("\n").slice(0, 1000);
}
