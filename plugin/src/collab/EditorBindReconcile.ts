import * as Y from "yjs";
import { diffRanges, type TextSplice } from "../utils/textDiff";

export const BIND_GUARDRAIL_MAX_DELETE = 128;
export const BIND_GUARDRAIL_MAX_INSERT = 2048;

export type BindContentReconcileAction = "none" | "view-diff" | "ytext-wins";
export type BindContentReconcileApplied =
  | "none"
  | "view-diff"
  | "ytext-wins-pristine"
  | "ytext-wins-stale-buffer"
  | "ytext-wins-large-delete"
  | "ytext-wins-large-insert";

export interface BindContentReconcilePlan {
  action: BindContentReconcileAction;
  applied: BindContentReconcileApplied;
  splices: TextSplice[];
  deletedChars: number;
  insertedChars: number;
}

export function planBindContentReconcile(
  yContent: string,
  viewContent: string,
  viewLooksPristine = false,
  viewMatchesUnboundContent = false
): BindContentReconcilePlan {
  if (yContent === viewContent) return { action: "none", applied: "none", splices: [], deletedChars: 0, insertedChars: 0 };
  const splices = diffRanges(yContent, viewContent);
  const deletedChars = splices.reduce((n, s) => n + s.delCount, 0);
  const insertedChars = splices.reduce((n, s) => n + s.insert.length, 0);
  if (viewLooksPristine) {
    return { action: "ytext-wins", applied: "ytext-wins-pristine", splices, deletedChars, insertedChars };
  }
  if (viewMatchesUnboundContent) {
    return { action: "ytext-wins", applied: "ytext-wins-stale-buffer", splices, deletedChars, insertedChars };
  }
  if (insertedChars > BIND_GUARDRAIL_MAX_INSERT) {
    return { action: "ytext-wins", applied: "ytext-wins-large-insert", splices, deletedChars, insertedChars };
  }
  if (deletedChars > BIND_GUARDRAIL_MAX_DELETE) {
    return { action: "ytext-wins", applied: "ytext-wins-large-delete", splices, deletedChars, insertedChars };
  }
  // A human's typed-while-unbound window cannot delete more than about a line.
  return { action: "view-diff", applied: "view-diff", splices, deletedChars, insertedChars };
}

export function shouldRetryBindContentReconcile(plan: BindContentReconcilePlan): boolean {
  return plan.action !== "none" && plan.applied !== "ytext-wins-pristine";
}

export interface SettledBindContentReconcilePlan {
  firstPlan: BindContentReconcilePlan;
  finalPlan: BindContentReconcilePlan;
}

export function planSettledBindContentReconcile(
  yContent: string,
  firstViewContent: string,
  secondViewContent: string,
  viewLooksPristine = false
): SettledBindContentReconcilePlan {
  const firstPlan = planBindContentReconcile(yContent, firstViewContent, viewLooksPristine);
  if (!shouldRetryBindContentReconcile(firstPlan)) return { firstPlan, finalPlan: firstPlan };
  return {
    firstPlan,
    finalPlan: planBindContentReconcile(yContent, secondViewContent, viewLooksPristine),
  };
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
