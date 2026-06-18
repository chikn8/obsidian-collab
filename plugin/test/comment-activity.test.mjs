import { isThreadUnread, latestCommentActivity } from "../src/utils/commentActivity.ts";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

console.log("comment activity\n");

const thread = {
  id: "t1",
  quote: "quote",
  resolved: false,
  authorUid: "u1",
  authorName: "Elijah",
  createdAt: 10,
  anchor: null,
  replies: [
    { id: "r1", byUid: "u1", byName: "Elijah", at: 10, text: "first", reactions: {} },
    { id: "r2", byUid: "u2", byName: "Saket", at: 20, text: "second", reactions: {} },
  ],
};

check("latest activity comes from newest reply", latestCommentActivity(thread).text === "second");
check("unread when collaborator activity is newer than read marker", isThreadUnread(thread, "u1", 15) === true);
check("read when marker catches up", isThreadUnread(thread, "u1", 20) === false);
check("own latest activity is not unread", isThreadUnread({ ...thread, replies: [{ id: "r3", byUid: "u1", byName: "Elijah", at: 30, text: "mine", reactions: {} }] }, "u1", 0) === false);
check("resolved threads are not unread", isThreadUnread({ ...thread, resolved: true }, "u1", 0) === false);

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
