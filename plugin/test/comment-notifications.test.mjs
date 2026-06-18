import { buildThreadAuthorNotification } from "../src/utils/commentNotifications.ts";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

console.log("comment notifications\n");

{
  const n = buildThreadAuthorNotification({
    kind: "reply",
    actorUid: "u2",
    actorName: "Saket",
    authorUid: "u1",
    fileName: "Plan.md",
    text: "I replied",
  });
  check("reply notifies thread author", n?.toUid === "u1" && n.title === "Saket replied to your comment in Plan.md" && n.body === "I replied", JSON.stringify(n));
}

{
  const n = buildThreadAuthorNotification({
    kind: "resolve",
    actorUid: "u2",
    actorName: "Saket",
    authorUid: "u1",
    fileName: "Plan.md",
    quote: "old context",
  });
  check("resolve notification uses quote fallback", n?.title === "Saket resolved your comment in Plan.md" && n.body === "old context", JSON.stringify(n));
}

{
  const self = buildThreadAuthorNotification({
    kind: "reply",
    actorUid: "u1",
    actorName: "Elijah",
    authorUid: "u1",
    fileName: "Plan.md",
    text: "self",
  });
  check("does not notify yourself", self === null, JSON.stringify(self));
}

{
  const dupe = buildThreadAuthorNotification({
    kind: "reply",
    actorUid: "u2",
    actorName: "Saket",
    authorUid: "u1",
    fileName: "Plan.md",
    text: "already mentioned",
    alreadyNotified: new Set(["u1"]),
  });
  check("does not duplicate mention notification", dupe === null, JSON.stringify(dupe));
}

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
