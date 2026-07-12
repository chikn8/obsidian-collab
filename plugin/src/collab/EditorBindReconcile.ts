import * as Y from "yjs";
import { diffRanges, type TextSplice } from "../utils/textDiff";

const BIND_GUARDRAIL_MIN_DELETE = 1024;
const BIND_GUARDRAIL_MIN_RATIO = 0.15;

export type BindContentReconcileAction = "none" | "view-diff" | "ytext-wins";
export type BindContentReconcileApplied = BindContentReconcileAction | "ytext-wins-pristine";

export interface BindContentReconcilePlan {
  action: BindContentReconcileAction;
  applied: BindContentReconcileApplied;
  splices: TextSplice[];
  deletedChars: number;
}

export function planBindContentReconcile(
  yContent: string,
  viewContent: string,
  viewLooksPristine = false
): BindContentReconcilePlan {
  if (yContent === viewContent) return { action: "none", applied: "none", splices: [], deletedChars: 0 };
  const splices = diffRanges(yContent, viewContent);
  const deletedChars = splices.reduce((n, s) => n + s.delCount, 0);
  if (viewLooksPristine) {
    return { action: "ytext-wins", applied: "ytext-wins-pristine", splices, deletedChars };
  }
  const action =
    deletedChars > BIND_GUARDRAIL_MIN_DELETE &&
    deletedChars > yContent.length * BIND_GUARDRAIL_MIN_RATIO
      ? "ytext-wins"
      : "view-diff";
  return { action, applied: action, splices, deletedChars };
}

export function applyBindContentPlanToYText(ytext: Y.Text, plan: BindContentReconcilePlan): void {
  if (plan.action !== "view-diff" || plan.splices.length === 0) return;
  const apply = () => {
    for (let i = plan.splices.length - 1; i >= 0; i--) {
      const { start, delCount, insert } = plan.splices[i];
      if (delCount > 0) ytext.delete(start, delCount);
      if (insert.length > 0) ytext.insert(start, insert);
    }
  };
  const doc = ytext.doc;
  if (doc) doc.transact(apply, "bind-content-reconcile");
  else apply();
}
