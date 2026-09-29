import { ConnectThrottle } from "../src/connectThrottle.ts";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

console.log("mux connect throttle\n");

let now = 1_000_000;
const throttle = new ConnectThrottle(20, 60_000, () => now);

{
  // A client with 1 s -> 60 s exponential backoff: never throttled.
  let delay = 1000;
  let rejected = 0;
  for (let i = 0; i < 40; i++) {
    if (!throttle.check("share|backoff-device").allowed) rejected++;
    now += delay;
    delay = Math.min(60_000, delay * 2);
  }
  check("a client with backoff is never throttled", rejected === 0, `rejected=${rejected}`);
}

{
  // The live loop: one connect per second, forever.
  const decisions = [];
  for (let i = 0; i < 60; i++) {
    decisions.push(throttle.check("share|looping-device"));
    now += 1000;
  }
  const allowed = decisions.filter((d) => d.allowed).length;
  const firsts = decisions.filter((d) => d.firstRejection).length;
  check("a 1/s loop is held to the limit per minute", allowed === 20, `allowed=${allowed}`);
  check("first rejection is flagged once per lockout", firsts === 1, `firsts=${firsts}`);
  check("rejections carry a Retry-After", decisions.filter((d) => !d.allowed).every((d) => d.retryAfterSec >= 1 && d.retryAfterSec <= 60));
  check("another device on the same share is unaffected", throttle.check("share|other-device").allowed);
}

{
  // After the loop stops, the device is let back in within one window.
  const key = "share|recovering-device";
  for (let i = 0; i < 25; i++) throttle.check(key);
  check("device is locked out right after the burst", !throttle.check(key).allowed);
  now += 60_000;
  check("lockout ends once the window drains", throttle.check(key).allowed);
}

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
