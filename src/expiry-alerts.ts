import type { CheckWithState } from "@lorenzh/pulse-contract";
import { type AlertEvaluation, type AlertLookup, subjectHash } from "./budget-alerts.ts";
import type { AlertState, ExpiryStage } from "./ledger.ts";
import type { ExpiryNotification } from "./types.ts";

/** Slack for clock skew between the probe and notify. */
const SKEW_MS = 60_000;
/** As the api's `WINDOW_INTERVALS`: a reading older than two intervals is stale. */
const FRESH_INTERVALS = 2;

/** Which expiry kinds have a subscribed channel. */
export interface ExpiryKinds {
  tls: boolean;
  domain: boolean;
}

interface Observation {
  days: number;
  observedMs: number;
}

type ExpiryCheck = Extract<CheckWithState, { type: "tls" | "domain" }>;

function isExpiryCheck(check: CheckWithState, kinds: ExpiryKinds): check is ExpiryCheck {
  return (check.type === "tls" && kinds.tls) || (check.type === "domain" && kinds.domain);
}

/** The reading of a check when it is usable: an integer, fresh, and newer than `observedAt`. */
function usedObservation(
  check: ExpiryCheck,
  observedAt: number | undefined,
  nowMs: number,
): Observation | undefined {
  const days = check.certDaysLeft;
  if (typeof days !== "number" || !Number.isInteger(days) || check.locations.length === 0) {
    return undefined;
  }
  const observedMs = Math.max(...check.locations.map((l) => l.result.timestamp));
  const isFresh =
    nowMs - observedMs <= FRESH_INTERVALS * check.intervalMs + SKEW_MS &&
    observedMs <= nowMs + SKEW_MS;
  const isNewer = observedAt === undefined || observedMs > observedAt;
  return isFresh && isNewer ? { days, observedMs } : undefined;
}

/** The milestone that a reading reaches from `stage`, or `undefined` when none is due. */
function milestoneOf(stage: ExpiryStage | undefined, days: number): ExpiryStage | undefined {
  if (days < 0 || stage === 3) return undefined;
  if (days <= 3) return 3;
  if (days <= 14 && stage === undefined) return 14;
  return undefined;
}

/** The next state; the observation time always advances, also without a stage change. */
function nextState(
  state: Omit<AlertState, "updatedAt"> | undefined,
  seen: Observation,
  milestone: ExpiryStage | undefined,
): Omit<AlertState, "updatedAt"> {
  if (seen.days > 14) return { observedAt: seen.observedMs };
  if (milestone === undefined) {
    return { stage: state?.stage, episodeAt: state?.episodeAt, observedAt: seen.observedMs };
  }
  const episodeAt = state?.stage === undefined ? seen.observedMs : state.episodeAt;
  return { stage: milestone, episodeAt, observedAt: seen.observedMs };
}

/**
 * The `tls-expiry` and `domain-expiry` events of one poll, with the state to store. A check warns
 * once at 14 days and once at 3 days per episode; only a reading above 14 days rearms it.
 */
export function expiryAlerts(
  checks: readonly CheckWithState[],
  lookup: AlertLookup,
  kinds: ExpiryKinds,
  nowMs: number,
): AlertEvaluation<ExpiryNotification> {
  const result: AlertEvaluation<ExpiryNotification> = { notifications: [], changes: [] };
  const proposed = new Map<string, Omit<AlertState, "updatedAt">>();
  for (const check of checks) {
    if (!isExpiryCheck(check, kinds)) continue;
    const state = proposed.get(check.id) ?? lookup("expiry", check.id);
    const seen = usedObservation(check, state?.observedAt, nowMs);
    if (!seen) continue;
    const milestone = milestoneOf(state?.stage, seen.days);
    const next = nextState(state, seen, milestone);
    proposed.set(check.id, next);
    if (milestone !== undefined && next.episodeAt !== undefined) {
      result.notifications.push({
        key: `expiry:${next.episodeAt}:${milestone}:${subjectHash(check.id)}`,
        event: check.type === "tls" ? "tls-expiry" : "domain-expiry",
        time: new Date(nowMs).toISOString(),
        timeMs: nowMs,
        subject: { kind: "check", id: check.id, name: check.name },
        expiry: { daysLeft: seen.days, milestone, observedMs: seen.observedMs },
      });
    }
  }
  for (const [subjectId, state] of proposed)
    result.changes.push({ kind: "expiry", subjectId, state });
  return result;
}
