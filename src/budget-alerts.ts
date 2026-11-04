import { createHash } from "node:crypto";
import type { Slo } from "@lorenzh/pulse-contract";
import type { AlertKind, AlertState, AlertUpsert } from "./ledger.ts";
import type { BudgetNotification } from "./types.ts";

/** "Once per day" is 24 elapsed hours, not a calendar day. */
export const BUDGET_REPEAT_MS = 86_400_000;

/** Reads the committed alert state of a subject. */
export type AlertLookup = (kind: AlertKind, subjectId: string) => AlertState | undefined;

/** The proposed changes of one rule in one poll; the caller commits them in one transaction. */
export interface AlertEvaluation<N> {
  notifications: N[];
  changes: AlertUpsert[];
}

/** A check or a component of the api with its optional SLO. */
export interface BudgetSubject {
  id: string;
  name: string;
  slo?: Slo | undefined;
}

/** The first 32 hex characters of the SHA-256 of the id, so no raw api id reaches a key. */
export function subjectHash(id: string): string {
  return createHash("sha256").update(id, "utf8").digest("hex").slice(0, 32);
}

function isLow(slo: Slo | undefined, threshold: number): slo is Slo & { budgetRemaining: number } {
  return slo !== undefined && slo.budgetRemaining !== null && slo.budgetRemaining < threshold;
}

function isDue(state: AlertState | undefined, nowMs: number): boolean {
  const last = state?.lastEventAt;
  return last === undefined || (nowMs >= last && nowMs - last >= BUDGET_REPEAT_MS);
}

/**
 * The `budget-low` events of one poll for the checks or the components, with the state to store.
 * A low subject gets an event when none was generated in the last 24 hours; nothing else changes.
 */
export function budgetAlerts(
  kind: "check" | "component",
  subjects: readonly BudgetSubject[],
  lookup: AlertLookup,
  threshold: number,
  nowMs: number,
): AlertEvaluation<BudgetNotification> {
  const alertKind: AlertKind = kind === "check" ? "budget-check" : "budget-component";
  const result: AlertEvaluation<BudgetNotification> = { notifications: [], changes: [] };
  const done = new Set<string>();
  for (const subject of subjects) {
    const { slo } = subject;
    if (done.has(subject.id) || !isLow(slo, threshold)) continue;
    if (!isDue(lookup(alertKind, subject.id), nowMs)) continue;
    done.add(subject.id);
    result.changes.push({ kind: alertKind, subjectId: subject.id, state: { lastEventAt: nowMs } });
    result.notifications.push({
      key: `budget:${kind}:${nowMs}:${subjectHash(subject.id)}`,
      event: "budget-low",
      time: new Date(nowMs).toISOString(),
      timeMs: nowMs,
      subject: { kind, id: subject.id, name: subject.name },
      budget: {
        remaining: slo.budgetRemaining,
        threshold,
        target: slo.target,
        availability: slo.availability,
        windowDays: slo.windowDays,
      },
    });
  }
  return result;
}
