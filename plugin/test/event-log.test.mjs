import * as Y from "yjs";
import { appendEvent, formatEvent, listEvents } from "../src/collab/EventLog.ts";
import { ErrorActivityGuard } from "../src/collab/ErrorActivityGuard.ts";
import { err, findErrPathArg, formatErrArgsForActivity, setErrSink } from "../src/utils/log.ts";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

console.log("activity event log\n");

const doc = new Y.Doc();
const events = doc.getArray("events");

appendEvent(events, {
  type: "message",
  shareId: "share-a",
  actorUid: "uid-a",
  actorName: "Elijah",
  deviceId: "device-a",
  text: "hello",
}, 3);
appendEvent(events, {
  type: "open",
  shareId: "share-a",
  actorUid: "uid-a",
  actorName: "Elijah",
  deviceId: "device-a",
  path: "Project/Note.md",
}, 3);
appendEvent(events, {
  type: "edit",
  shareId: "share-a",
  actorUid: "uid-a",
  actorName: "Elijah",
  deviceId: "device-a",
  path: "Project/Note.md",
  count: 4,
  details: { token: "secret", safe: "ok" },
}, 3);
appendEvent(events, {
  type: "delete",
  shareId: "share-a",
  actorUid: "uid-b",
  actorName: "Friend",
  deviceId: "device-b",
  path: "Old.md",
}, 3);

const listed = listEvents(events, 10);
check("caps old events", listed.length === 3 && listed[0].type === "open");
check("formats edit compaction", formatEvent(listed[1]).includes("edited Project/Note.md 4 times"));
check("redacts details", !("token" in (listed[1].details || {})) && listed[1].details?.safe === "ok");
check("keeps chronological order", listed.map((e) => e.type).join(",") === "open,edit,delete");

const errorDoc = new Y.Doc();
const errorEvents = errorDoc.getArray("events");
const activityMessage = formatErrArgsForActivity("sync", [
  "write failed",
  "Shared/Note.md",
  { token: "should-not-leak", safe: "ok" },
  new Error("boom"),
]);
appendEvent(errorEvents, {
  type: "error",
  shareId: "share-a",
  actorUid: "uid-a",
  actorName: "Elijah",
  deviceId: "device-a",
  path: "Note.md",
  text: activityMessage + " ".repeat(5) + "x".repeat(300),
});
errorEvents.push([{
  type: "future-event",
  shareId: "share-a",
  actorUid: "uid-a",
  actorName: "Elijah",
  deviceId: "device-a",
  text: "newer client event",
}]);
const listedErrors = listEvents(errorEvents, 10);
check("serializes error events", listedErrors[0].type === "error" && listedErrors[0].path === "Note.md");
check("redacts error event message input", !listedErrors[0].text.includes("should-not-leak") && listedErrors[0].text.includes("[redacted]"));
check("truncates error event message", listedErrors[0].text.length <= 223, listedErrors[0].text.length);
check("formats error event", formatEvent(listedErrors[0]).includes("Plugin error:"));
check("unknown event types do not crash", listedErrors[1].type === "future-event" && formatEvent(listedErrors[1]) === "");

const originalNow = Date.now;
try {
  let now = 1_000_000;
  Date.now = () => now;

  let guard = new ErrorActivityGuard();
  check("dedupes identical errors within window",
    guard.next("same failure", "Note.md") === "post" &&
    guard.next("same failure", "Note.md") === "skip");
  now += 5 * 60_000;
  check("allows duplicate after dedupe window", guard.next("same failure", "Note.md") === "post");

  guard = new ErrorActivityGuard();
  const actions = [];
  for (let i = 0; i < 12; i++) actions.push(guard.next(`failure ${i}`, "Note.md"));
  check("caps hourly error events with muted marker",
    actions.filter((action) => action === "post").length === 10 &&
    actions.filter((action) => action === "muted").length === 1 &&
    actions.at(-1) === "skip",
    actions.join(","));
  now += 60 * 60_000;
  check("resumes after hourly window frees", guard.next("failure after window", "Note.md") === "post");
} finally {
  Date.now = originalNow;
}

const originalConsoleError = console.error;
try {
  const calls = [];
  const reporter = {
    reportErrorEvent(message, path) {
      calls.push({ type: "error", text: message, path });
      err("inner", "Shared/Note.md", "post failed");
    },
  };
  let sinkCalls = 0;
  console.error = () => {};
  setErrSink((ns, args) => {
    sinkCalls++;
    const path = findErrPathArg(args, (candidate) => candidate.startsWith("Shared/"));
    if (path) reporter.reportErrorEvent(formatErrArgsForActivity(ns, args), path);
  });
  err("outer", "Shared/Note.md", "outer failed");
  console.error = originalConsoleError;
  check("reentrancy guard prevents recursive error sink", sinkCalls === 1 && calls.length === 1, `sink=${sinkCalls} calls=${calls.length}`);

  const unattributed = [];
  console.error = () => {};
  setErrSink((_ns, args) => {
    const path = findErrPathArg(args, (candidate) => candidate.startsWith("Shared/"));
    if (path) unattributed.push(path);
  });
  err("outer", "no share path here");
  console.error = originalConsoleError;
  check("unattributable errors are not posted", unattributed.length === 0);
} finally {
  setErrSink(null);
  console.error = originalConsoleError;
}

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
