import { getMetricCounters, incMetric, resetMetricCountersForTest } from "../src/metrics.ts";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

console.log("server metrics\n");

resetMetricCountersForTest();
let counters = getMetricCounters();
check("starts known counters at zero", counters.save_failures === 0 && counters.rate_limited === 0);

incMetric("save_failures");
incMetric("rate_limited", 3);
incMetric("rate_limited", -1);
counters = getMetricCounters();
check("increments named counters", counters.save_failures === 1 && counters.rate_limited === 3, JSON.stringify(counters));

const copy = getMetricCounters();
copy.save_failures = 99;
check("returns a defensive copy", getMetricCounters().save_failures === 1);

resetMetricCountersForTest();
counters = getMetricCounters();
check("resets counters for tests", counters.save_failures === 0 && counters.rate_limited === 0);

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
