/**
 * Bind-time editor/Y.Text reconciliation.
 *
 * The bind path has no common ancestor for a temporarily-unbound editor buffer,
 * so the intended default is "view wins": apply the view's diff to Y.Text before
 * yCollab attaches. A ytext-only remote insertion therefore looks like a view
 * deletion and is removed unless it trips the large-delete guardrail. A buffer
 * matching a recent plugin disk write has no unsynced local content, so Y.Text
 * wins instead.
 */
import * as Y from "yjs";
import {
  applyBindContentPlanToYText,
  planSettledBindContentReconcile,
  planBindContentReconcile,
} from "../src/collab/EditorBindReconcile.ts";
import { EchoGuard } from "../src/collab/EchoGuard.ts";
import {
  clearUnboundEditorContent,
  matchesUnboundEditorContent,
  stashUnboundEditorContent,
} from "../src/collab/EditorBindStash.ts";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name} ${extra}`); }
}

function makeText(content) {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  if (content) text.insert(0, content);
  return { doc, text };
}

console.log("editor binding reconcile\n");

{
  const { text } = makeText("alpha\ncharlie\n");
  const view = "alpha\nbravo\ncharlie\n";
  const plan = planBindContentReconcile(text.toString(), view);
  applyBindContentPlanToYText(text, plan);
  check("view insertion is applied to ytext", plan.action === "view-diff" && text.toString() === view,
    `action=${plan.action} text=${JSON.stringify(text.toString())}`);
  check("view insertion lands at the correct position",
    plan.splices.length === 1 && plan.splices[0].start === "alpha\n".length && plan.splices[0].insert === "bravo\n",
    JSON.stringify(plan.splices));
}

{
  const path = "Shared/note.md";
  const yContent = "alpha\nremote\ncharlie\n";
  const view = "alpha\ncharlie\n";
  const { text } = makeText(yContent);
  const echo = new EchoGuard();
  echo.mark(path, view);
  const plan = planBindContentReconcile(text.toString(), view, echo.hasRecentFingerprint(path, view));
  applyBindContentPlanToYText(text, plan);
  check("pristine stale view makes ytext win for a small remote insertion",
    plan.action === "ytext-wins" && plan.applied === "ytext-wins-pristine" && text.toString() === yContent,
    `action=${plan.action} text=${JSON.stringify(text.toString())}`);
  check("EchoGuard pristine peek does not consume the normal echo mark",
    echo.isEcho(path, view) === true);
}

{
  const path = "Shared/note.md";
  const yContent = "alpha\ncharlie\n";
  const view = "alpha\nbravo\ncharlie\n";
  const { text } = makeText(yContent);
  const echo = new EchoGuard();
  echo.mark(path, yContent);
  const plan = planBindContentReconcile(text.toString(), view, echo.hasRecentFingerprint(path, view));
  applyBindContentPlanToYText(text, plan);
  check("user-edited buffer does not match the pristine fingerprint", plan.applied === "view-diff");
  check("small non-pristine view edit still applies to ytext", text.toString() === view,
    `action=${plan.action} text=${JSON.stringify(text.toString())}`);
}

{
  const view = "v".repeat(38);
  const yContent = `${view}${"p".repeat(371)}`;
  const plan = planBindContentReconcile(yContent, view);
  check("38-vs-409 stale buffer is not applied as a view diff",
    yContent.length === 409 && plan.action === "ytext-wins" && plan.applied === "ytext-wins-large-delete",
    `viewLen=${view.length} yLen=${yContent.length} deleted=${plan.deletedChars} applied=${plan.applied}`);
}

{
  const view = "starttypedend";
  const atBudget = planBindContentReconcile(`start${"x".repeat(128)}end`, view);
  const overBudget = planBindContentReconcile(`start${"x".repeat(129)}end`, view);
  check("128 deleted chars remains eligible for a view diff",
    atBudget.action === "view-diff" && atBudget.deletedChars === 128 && atBudget.insertedChars < 2048,
    `action=${atBudget.action} deleted=${atBudget.deletedChars} inserted=${atBudget.insertedChars}`);
  check("129 deleted chars makes ytext win",
    overBudget.action === "ytext-wins" && overBudget.applied === "ytext-wins-large-delete" && overBudget.deletedChars === 129,
    `action=${overBudget.action} deleted=${overBudget.deletedChars} applied=${overBudget.applied}`);
}

{
  const path = "Shared/stashed-note.md";
  const at = 1_000_000;
  const view = "local buffer\n";
  const yContent = "local buffer\npeer addition\n";
  stashUnboundEditorContent(path, view, at);
  const stashedPlan = planBindContentReconcile(
    yContent,
    view,
    false,
    matchesUnboundEditorContent(path, view, at + 1)
  );
  check("unbound Y.Text stash makes matching stale buffer yield to ytext",
    stashedPlan.action === "ytext-wins" && stashedPlan.applied === "ytext-wins-stale-buffer",
    `action=${stashedPlan.action} applied=${stashedPlan.applied}`);
  clearUnboundEditorContent(path);
  check("stash is cleared after a successful bind", !matchesUnboundEditorContent(path, view, at + 1));

  stashUnboundEditorContent(path, view, at);
  const expiredPlan = planBindContentReconcile(
    yContent,
    view,
    false,
    matchesUnboundEditorContent(path, view, at + 10 * 60_000 + 1)
  );
  check("expired unbound stash is ignored", expiredPlan.applied === "view-diff", `applied=${expiredPlan.applied}`);
  clearUnboundEditorContent(path);
}

{
  const rich = `${"0123456789abcdef\n".repeat(100)}tail\n`;
  const staleView = `${rich.slice(0, 80)}tail\n`;
  const { text } = makeText(rich);
  const plan = planBindContentReconcile(text.toString(), staleView);
  applyBindContentPlanToYText(text, plan);
  check("mass-deletion guardrail makes ytext win", plan.action === "ytext-wins", `action=${plan.action}`);
  check("mass-deletion guardrail reports large-delete", plan.applied === "ytext-wins-large-delete", `applied=${plan.applied}`);
  check("guardrail does not delete synced ytext", text.toString() === rich, `len=${text.toString().length}`);
}

{
  const yContent = "y".repeat(37);
  const foreignView = "foreign-buffer\n".repeat(477).slice(0, 6199);
  const { text } = makeText(yContent);
  const plan = planBindContentReconcile(text.toString(), foreignView);
  applyBindContentPlanToYText(text, plan);
  check("large foreign insertion makes ytext win",
    plan.action === "ytext-wins" && plan.applied === "ytext-wins-large-insert",
    `action=${plan.action} applied=${plan.applied} inserted=${plan.insertedChars}`);
  check("large foreign insertion does not overwrite ytext", text.toString() === yContent,
    `len=${text.toString().length}`);
}

{
  const yContent = "small synced note\n";
  const under = `${yContent}${"x".repeat(2048)}`;
  const over = `${yContent}${"x".repeat(2049)}`;
  const underPlan = planBindContentReconcile(yContent, under);
  const overPlan = planBindContentReconcile(yContent, over);
  check("insert at 2048-char boundary is preserved as view-diff",
    underPlan.action === "view-diff" && underPlan.applied === "view-diff" && underPlan.insertedChars === 2048,
    `action=${underPlan.action} applied=${underPlan.applied} inserted=${underPlan.insertedChars}`);
  check("insert over 2048-char boundary makes ytext win",
    overPlan.action === "ytext-wins" && overPlan.applied === "ytext-wins-large-insert" && overPlan.insertedChars === 2049,
    `action=${overPlan.action} applied=${overPlan.applied} inserted=${overPlan.insertedChars}`);
}

{
  const yContent = "settled synced content\n";
  const transientView = `${yContent}typed during a short unbound gap\n`;
  const settled = planSettledBindContentReconcile(yContent, transientView, yContent);
  check("view diff settles to equal content before applying",
    settled.firstPlan.applied === "view-diff" && settled.finalPlan.action === "none",
    `first=${settled.firstPlan.applied} final=${settled.finalPlan.applied}`);
}

{
  const yContent = "settled synced content\n";
  const foreignView = "foreign-buffer\n".repeat(300);
  const settled = planSettledBindContentReconcile(yContent, foreignView, yContent);
  check("settle retry turns foreign buffer that becomes equal into no-op",
    settled.firstPlan.applied === "ytext-wins-large-insert" && settled.finalPlan.action === "none",
    `first=${settled.firstPlan.applied} final=${settled.finalPlan.applied}`);

  const stillForeign = planSettledBindContentReconcile(yContent, foreignView, foreignView);
  check("settle retry keeps ytext winning when foreign buffer remains",
    stillForeign.firstPlan.applied === "ytext-wins-large-insert" &&
      stillForeign.finalPlan.action === "ytext-wins" &&
      stillForeign.finalPlan.applied === "ytext-wins-large-insert",
    `first=${stillForeign.firstPlan.applied} final=${stillForeign.finalPlan.applied}`);
}

{
  const { doc, text } = makeText("same\ncontent\n");
  let transactions = 0;
  doc.on("afterTransaction", () => { transactions++; });
  const plan = planBindContentReconcile(text.toString(), "same\ncontent\n");
  applyBindContentPlanToYText(text, plan);
  check("equal content is a no-op decision", plan.action === "none" && plan.splices.length === 0);
  check("equal content creates no Yjs transactions", transactions === 0, `transactions=${transactions}`);
}

console.log("");
if (failures > 0) { console.error(`FAILED - ${failures} assertion(s) failed`); process.exit(1); }
else console.log("ALL PASSED");
