import { getRuntimeHealth } from "../src/runtime.ts";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

console.log("server runtime\n");

const originalMaxRss = process.env.MEMORY_HEALTH_MAX_RSS_BYTES;
const originalMaxHeap = process.env.MEMORY_HEALTH_MAX_HEAP_USED_BYTES;
try {
  delete process.env.MEMORY_HEALTH_MAX_RSS_BYTES;
  delete process.env.MEMORY_HEALTH_MAX_HEAP_USED_BYTES;
  let health = getRuntimeHealth();
  check("reports process memory", health.memory.rss > 0 && health.memory.heapSizeLimit > 0, JSON.stringify(health));
  check("runtime is healthy without explicit tiny threshold", health.ok === true, JSON.stringify(health));

  process.env.MEMORY_HEALTH_MAX_RSS_BYTES = "0";
  health = getRuntimeHealth();
  check("zero rss threshold disables rss health", health.limits.maxRssBytes === null, JSON.stringify(health));

  process.env.MEMORY_HEALTH_MAX_RSS_BYTES = "1";
  health = getRuntimeHealth();
  check("rss threshold degrades runtime health", health.ok === false && health.rssTooHigh === true, JSON.stringify(health));

  delete process.env.MEMORY_HEALTH_MAX_RSS_BYTES;
  process.env.MEMORY_HEALTH_MAX_HEAP_USED_BYTES = "1";
  health = getRuntimeHealth();
  check("heap threshold degrades runtime health", health.ok === false && health.heapTooHigh === true, JSON.stringify(health));
} finally {
  if (originalMaxRss === undefined) delete process.env.MEMORY_HEALTH_MAX_RSS_BYTES;
  else process.env.MEMORY_HEALTH_MAX_RSS_BYTES = originalMaxRss;
  if (originalMaxHeap === undefined) delete process.env.MEMORY_HEALTH_MAX_HEAP_USED_BYTES;
  else process.env.MEMORY_HEALTH_MAX_HEAP_USED_BYTES = originalMaxHeap;
}

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
