import {
  findMentionedUsers,
  matchingMentionUsers,
  mentionTextFor,
  mentionTokenAt,
} from "../src/utils/mentions.ts";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

console.log("mentions\n");

const users = [
  { uid: "a", name: "Alice" },
  { uid: "b", name: "Bob Smith" },
  { uid: "c", name: "Casey" },
];

check("bare mention matches single-word name", findMentionedUsers("hi @Alice", users).map((u) => u.uid).join(",") === "a");
check("quoted mention matches full name", findMentionedUsers('hi @"Bob Smith"', users).map((u) => u.uid).join(",") === "b");
check("bare mention does not partial-match", findMentionedUsers("hi @Alice2", users).length === 0);
check("matchingMentionUsers filters case-insensitively", matchingMentionUsers(users, "bo")[0]?.uid === "b");

const bare = mentionTokenAt("reply @Al", "reply @Al".length);
check("bare token found", bare?.from === 6 && bare?.query === "Al", JSON.stringify(bare));
const quoted = mentionTokenAt('reply @"Bob S', 'reply @"Bob S'.length);
check("quoted token found", quoted?.from === 6 && quoted?.query === "Bob S" && quoted.quoted, JSON.stringify(quoted));
check("single-word completion is bare", mentionTextFor(users[0]) === "@Alice ");
check("full-name completion is quoted", mentionTextFor(users[1]) === '@"Bob Smith" ');

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
