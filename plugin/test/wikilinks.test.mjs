import { rewriteObsidianLinks } from "../src/utils/wikiLinks.ts";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

console.log("wikilink rewrite\n");

{
  const result = rewriteObsidianLinks(
    "See [[Notes/Old#Heading|the old note]] and ![[Old]].",
    { oldRelPath: "Notes/Old.md", newRelPath: "Archive/New.md" }
  );
  check("rewrites path links and embeds", result.content === "See [[Archive/New#Heading|the old note]] and ![[New]].", result.content);
  check("counts replacements", result.replacements === 2, String(result.replacements));
}

{
  const result = rewriteObsidianLinks(
    "[[Old.md]] [[Other/Old.md]] [[#Heading]]",
    {
      oldRelPath: "Notes/Old.md",
      newRelPath: "Notes/New.md",
      resolveLink: (target) => target === "Old.md" ? "Notes/Old.md" : "Other/Old.md",
    }
  );
  check("uses resolver to avoid same-basename collisions", result.content === "[[New.md]] [[Other/Old.md]] [[#Heading]]", result.content);
}

{
  const result = rewriteObsidianLinks(
    "Inline `[[Old]]` stays.\n```\n[[Old]]\n```\nOutside [[Old]].",
    { oldRelPath: "Old.md", newRelPath: "New.md" }
  );
  check("skips inline code and fenced code", result.content === "Inline `[[Old]]` stays.\n```\n[[Old]]\n```\nOutside [[New]].", result.content);
}

{
  const result = rewriteObsidianLinks(
    "Canvas link [[Boards/Old.canvas]] and short [[Old.canvas]].",
    { oldRelPath: "Boards/Old.canvas", newRelPath: "Boards/New.canvas" }
  );
  check("keeps non-markdown extensions", result.content === "Canvas link [[Boards/New.canvas]] and short [[New.canvas]].", result.content);
}

console.log("");
if (failures > 0) { console.error(`FAILED — ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
