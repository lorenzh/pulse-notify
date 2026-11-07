import { SUBSCRIPTION_CONFIRM_TTL_MS } from "@lorenzh/pulse-contract";
import type { ConfirmationJobInput } from "./subscriber-fanout.ts";
import {
  newConfirmToken,
  newSubscriptionId,
  type RandomBytes,
  tokenDigest,
  unsubscribeToken,
  unsubscribeTokenId,
} from "./subscriber-mail.ts";
import type { SubscriberStore, SubscriptionRow } from "./subscriber-store.ts";

/** A pending row gets no new mail within this time of its last one (L3). */
export const CONFIRM_COOLDOWN_MS = 600_000;
/** A pending row gets at most this many confirmation mails (L4). */
export const CONFIRM_SENDS_MAX = 3;
/** The global window of queued confirmation mails (L5). */
export const CONFIRM_WINDOW_MS = 3_600_000;
/** The confirmation queue size that refuses new mail (L6). */
export const QUEUE_LIMIT = 100;

export type SubscribeOutcome = "queued" | "known" | "limited";
export type TokenOutcome = "ok" | "invalid";
export type SubscriptionLimit = "capacity" | "pending" | "window" | "queue";

/** The confirmation queue as the operations see it (worker 1). */
export interface ConfirmationQueue {
  size: () => number;
  enqueue: (job: ConfirmationJobInput) => boolean;
  cancel: (id: string) => void;
}

export interface SubscriptionOperationsDeps {
  store: SubscriberStore;
  queue: ConfirmationQueue;
  /** The HMAC key, 64 lowercase hex characters. */
  key: string;
  max: number;
  maxPending: number;
  confirmPerHour: number;
  random?: RandomBytes;
  /** The first limit that applied: `pulse_notify_subscription_limited_total`. */
  onLimited?: (limit: SubscriptionLimit) => void;
}

/** The operations of R5. All are synchronous: no path waits for SMTP or sets a timer. */
export interface SubscriptionOperations {
  subscribe: (email: string, now: number) => SubscribeOutcome;
  confirm: (token: string, now: number) => TokenOutcome;
  unsubscribe: (token: string) => TokenOutcome;
}

type Decision =
  | { outcome: "known" }
  | { outcome: "limited"; limit: SubscriptionLimit }
  | { outcome: "queued"; job: ConfirmationJobInput; replaces?: string };

const isExpired = (row: SubscriptionRow, now: number): boolean =>
  row.state === "pending" && (row.confirmExpiresAt ?? 0) <= now;

export function createSubscriptionOperations(
  deps: SubscriptionOperationsDeps,
): SubscriptionOperations {
  const { store, queue } = deps;
  /** Queue times of confirmation mails in the last hour; in memory, no address. */
  let window: number[] = [];

  const sharedLimit = (now: number): SubscriptionLimit | undefined => {
    window = window.filter((at) => now - at < CONFIRM_WINDOW_MS);
    if (window.length >= deps.confirmPerHour) return "window";
    if (queue.size() >= QUEUE_LIMIT) return "queue";
    return undefined;
  };

  const newJob = (
    id: string,
    email: string,
    now: number,
    confirmSends: number,
  ): { job: ConfirmationJobInput; digest: string } => {
    const { token, digest } = newConfirmToken(deps.random);
    return {
      digest,
      job: {
        id,
        digest,
        expiresAt: now + SUBSCRIPTION_CONFIRM_TTL_MS,
        address: email,
        confirmToken: token,
        unsubscribeToken: unsubscribeToken(id, deps.key),
        confirmSends,
      },
    };
  };

  const decidePending = (row: SubscriptionRow, now: number): Decision => {
    if (
      now - (row.lastSentAt ?? 0) < CONFIRM_COOLDOWN_MS ||
      row.confirmSends >= CONFIRM_SENDS_MAX
    ) {
      return { outcome: "known" };
    }
    const limit = sharedLimit(now);
    if (limit !== undefined) return { outcome: "limited", limit };
    const { job, digest } = newJob(row.id, row.email, now, row.confirmSends + 1);
    store.renewPending(row.id, { now, digest, expiresAt: job.expiresAt });
    return { outcome: "queued", job, replaces: row.id };
  };

  const decideNew = (email: string, now: number): Decision => {
    const counts = store.counts();
    let limit: SubscriptionLimit | undefined;
    if (counts.total >= deps.max) limit = "capacity";
    else if (counts.pending >= deps.maxPending) limit = "pending";
    else limit = sharedLimit(now);
    if (limit !== undefined) return { outcome: "limited", limit };
    const id = newSubscriptionId(deps.random);
    const { job, digest } = newJob(id, email, now, 1);
    store.insertPending({ id, email, now, digest, expiresAt: job.expiresAt });
    return { outcome: "queued", job };
  };

  return {
    subscribe: (email, now) => {
      const decision = store.transaction((): Decision => {
        let row = store.subscriptionByEmail(email);
        if (row !== undefined && isExpired(row, now)) {
          store.deleteSubscription(row.id);
          // Free its queue slot before the L6 check; an expired job never sends anyway.
          queue.cancel(row.id);
          row = undefined;
        }
        if (row?.state === "confirmed") return { outcome: "known" };
        return row === undefined ? decideNew(email, now) : decidePending(row, now);
      });
      // Queue changes follow the commit (D19), before the caller answers.
      if (decision.outcome === "limited") deps.onLimited?.(decision.limit);
      if (decision.outcome === "queued") {
        if (decision.replaces !== undefined) queue.cancel(decision.replaces);
        window.push(now);
        queue.enqueue(decision.job);
      }
      return decision.outcome;
    },
    confirm: (token, now) => {
      const row = store.subscriptionByDigest(tokenDigest(token));
      if (row === undefined || isExpired(row, now)) return "invalid";
      if (row.state === "pending" && store.confirm(row.id, now)) queue.cancel(row.id);
      return "ok";
    },
    unsubscribe: (token) => {
      const id = unsubscribeTokenId(token, deps.key);
      if (id === undefined) return "invalid";
      store.deleteSubscription(id);
      queue.cancel(id);
      return "ok";
    },
  };
}
