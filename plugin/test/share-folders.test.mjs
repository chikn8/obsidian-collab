import {
  cleanShareFolder,
  shareFolderOverlaps,
} from "../src/utils/shareFolders.ts";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

console.log("share folders\n");

const shares = [
  { id: "kill-ai", label: "Kill AI", localFolder: "Kill AI" },
  { id: "game", label: "Game Dev", localFolder: "Game Development" },
];

check("normalizes slash variants", cleanShareFolder(" /Shared//Game\\Dev/ ") === "Shared/Game/Dev");
check("detects nested child overlap", shareFolderOverlaps(shares, "Kill AI/Game Development")?.id === "kill-ai");
check("detects parent overlap", shareFolderOverlaps(shares, "Kill") === null);
check("detects exact overlap", shareFolderOverlaps(shares, "Game Development/")?.id === "game");
check("allows sibling share", shareFolderOverlaps(shares, "Game Design") === null);
check("can ignore current share while repointing", shareFolderOverlaps(shares, "Game Development", "game") === null);
check("still blocks repointing into another share", shareFolderOverlaps(shares, "Kill AI/Subfolder", "game")?.id === "kill-ai");

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
