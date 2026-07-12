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
  planBindContentReconcile,
} from "../src/collab/EditorBindReconcile.ts";
import { EchoGuard } from "../src/collab/EchoGuard.ts";

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
  const rich = `${"0123456789abcdef\n".repeat(100)}tail\n`;
  const staleView = `${rich.slice(0, 80)}tail\n`;
  const { text } = makeText(rich);
  const plan = planBindContentReconcile(text.toString(), staleView);
  applyBindContentPlanToYText(text, plan);
  check("mass-deletion guardrail makes ytext win", plan.action === "ytext-wins", `action=${plan.action}`);
  check("guardrail does not delete synced ytext", text.toString() === rich, `len=${text.toString().length}`);
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
