import fs from "fs";
import v8 from "v8";

function readOptionalNonnegativeNumberEnv(name: string): number | null {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function readRatioEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] || "");
  if (!Number.isFinite(value) || value <= 0 || value >= 1) return fallback;
  return value;
}

function readMemoryLimitFile(filePath: string): number | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw || raw === "max") return null;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function detectedCgroupMemoryLimitBytes(): number | null {
  // cgroup v2, then v1. Host-level "unlimited" values are ignored below.
  const limit =
    readMemoryLimitFile("/sys/fs/cgroup/memory.max") ??
    readMemoryLimitFile("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  if (!limit) return null;
  if (limit >= Number.MAX_SAFE_INTEGER || limit > 1_000_000_000_000_000) return null;
  return limit;
}

export function getRuntimeHealth() {
  const memory = process.memoryUsage();
  const heapStats = v8.getHeapStatistics();
  const cgroupMemoryLimitBytes = detectedCgroupMemoryLimitBytes();
  const configuredMaxRssBytes = readOptionalNonnegativeNumberEnv("MEMORY_HEALTH_MAX_RSS_BYTES");
  const cgroupRatio = readRatioEnv("MEMORY_HEALTH_CGROUP_RATIO", 0.92);
  const cgroupMaxRssBytes =
    cgroupMemoryLimitBytes !== null ? Math.floor(cgroupMemoryLimitBytes * cgroupRatio) : 0;
  const maxRssBytes = configuredMaxRssBytes !== null ? configuredMaxRssBytes : cgroupMaxRssBytes;
  const maxHeapUsedBytes = readOptionalNonnegativeNumberEnv("MEMORY_HEALTH_MAX_HEAP_USED_BYTES") ?? 0;
  const rssTooHigh = maxRssBytes > 0 && memory.rss >= maxRssBytes;
  const heapTooHigh = maxHeapUsedBytes > 0 && memory.heapUsed >= maxHeapUsedBytes;

  return {
    ok: !rssTooHigh && !heapTooHigh,
    memory: {
      rss: memory.rss,
      heapTotal: memory.heapTotal,
      heapUsed: memory.heapUsed,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers,
      heapSizeLimit: heapStats.heap_size_limit,
    },
    limits: {
      maxRssBytes: maxRssBytes || null,
      configuredMaxRssBytes,
      cgroupMemoryLimitBytes,
      cgroupRatio: cgroupMemoryLimitBytes !== null ? cgroupRatio : null,
      maxHeapUsedBytes: maxHeapUsedBytes || null,
    },
    pressure: {
      rss: maxRssBytes > 0 ? memory.rss / maxRssBytes : null,
      heapUsed: maxHeapUsedBytes > 0 ? memory.heapUsed / maxHeapUsedBytes : null,
    },
    rssTooHigh,
    heapTooHigh,
    node: {
      version: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      nodeOptions: process.env.NODE_OPTIONS || "",
      execArgv: process.execArgv,
    },
  };
}
