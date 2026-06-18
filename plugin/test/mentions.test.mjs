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

const sameNameDevices = [
  { uid: "desktop", name: "Elijah" },
  { uid: "phone", name: "Elijah" },
  { uid: "other", name: "Elijah R" },
];
const groupedMatches = matchingMentionUsers(sameNameDevices, "eli");
check("same-name devices show one completion", groupedMatches.length === 2 && groupedMatches[0]?.uids?.join(",") === "desktop,phone", JSON.stringify(groupedMatches));
const groupedMentions = findMentionedUsers("hi @Elijah", sameNameDevices);
check("same-name mention keeps all device uids", groupedMentions.length === 1 && groupedMentions[0]?.uids?.join(",") === "desktop,phone", JSON.stringify(groupedMentions));

const bare = mentionTokenAt("reply @Al", "reply @Al".length);
check("bare token found", bare?.from === 6 && bare?.query === "Al", JSON.stringify(bare));
const quoted = mentionTokenAt('reply @"Bob S', 'reply @"Bob S'.length);
check("quoted token found", quoted?.from === 6 && quoted?.query === "Bob S" && quoted.quoted, JSON.stringify(quoted));
check("single-word completion is bare", mentionTextFor(users[0]) === "@Alice ");
check("full-name completion is quoted", mentionTextFor(users[1]) === '@"Bob Smith" ');

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
