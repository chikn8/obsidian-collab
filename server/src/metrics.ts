export const METRIC_NAMES = [
  "save_failures",
  "snapshot_failures",
  "disconnects",
  "revocations",
  "rejected_writes",
  "rejected_paths",
  "rejected_awareness",
  "rate_limited",
  "backpressure_closed",
  "send_failures",
  "client_errors",
  "mux_room_rejections",
] as const;

export type MetricName = typeof METRIC_NAMES[number];

const counters: Record<MetricName, number> = Object.fromEntries(
  METRIC_NAMES.map((name) => [name, 0])
) as Record<MetricName, number>;

export function incMetric(name: MetricName, amount = 1): void {
  if (!Number.isFinite(amount) || amount <= 0) return;
  counters[name] += amount;
}

export function getMetricCounters(): Record<MetricName, number> {
  return { ...counters };
}

export function resetMetricCountersForTest(): void {
  for (const name of METRIC_NAMES) counters[name] = 0;
}
