import type { Logger } from "@lorenzh/pulse-kit";
import { errorFields, PartialDeliveryError, PermanentDeliveryError } from "./errors.ts";
import type { Ledger } from "./ledger.ts";
import type { Notification, RecipientProgress, Sender, Sleep } from "./types.ts";

export const DEFAULT_RETRY_DELAY_MS = 1000;
export const DEFAULT_RETRY_MAX_DELAY_MS = 60000;
export const DEFAULT_RETRY_ATTEMPTS = 12;

export interface ChannelDeliveryOptions {
  channelId: string;
  send: Sender;
  ledger: Ledger;
  sleep: Sleep;
  /** Delay before the first retry; it doubles for each further retry. */
  retryDelayMs: number;
  /** Upper bound of the delay between attempts. */
  retryMaxDelayMs?: number | undefined;
  /** Total attempts per event; 0 retries without end. */
  retryAttempts?: number | undefined;
  logger: Logger;
  /** Called when a notification leaves the worker, whatever the outcome. */
  release?: (key: string) => void;
  /** True when a queued notification is out of date and must not be sent (a late reminder). */
  isStale?: (notification: Notification) => boolean;
  /** Called once per event that ended as delivered or failed. */
  onOutcome?: (outcome: "delivered" | "failed") => void;
}

type Outcome =
  | { kind: "delivered"; attempts: number }
  | { kind: "failed"; attempts: number; error: unknown; isPermanent: boolean }
  | { kind: "dropped" }
  | { kind: "stopped" };

type AttemptResult =
  | { outcome: Outcome; error?: never; progress?: RecipientProgress | undefined }
  | { outcome?: never; error: unknown; progress?: RecipientProgress | undefined };

/** Delay before retry `n` (1, 2, ...): `min(initial * 2^(n-1), max)`. */
export function retryDelay(n: number, initialMs: number, maxMs: number): number {
  return Math.min(initialMs * 2 ** (n - 1), maxMs);
}

/**
 * The final outcome of a failed attempt, or `undefined` when a retry follows. A permanent error
 * ends the event at once, whatever the attempt limit is; a limit of 0 never ends a retryable one.
 */
function failureOf(err: unknown, attempt: number, limit: number): Outcome | undefined {
  const isPermanent =
    err instanceof PermanentDeliveryError ||
    (err instanceof PartialDeliveryError && err.isPermanent);
  if (!isPermanent && (limit === 0 || attempt < limit)) return undefined;
  return { kind: "failed", attempts: attempt, error: err, isPermanent };
}

/**
 * The scheduler of one channel. Each event is a job that is `ready` (FIFO), `sending` (at most one
 * per channel), or `waiting` for its own retry timer. A waiting job does not block the channel; when
 * its timer ends it goes to the end of the ready queue. Each job keeps its own recipient progress.
 */
export class ChannelDelivery {
  readonly #opts: ChannelDeliveryOptions;
  /** Turn grants of the ready jobs, in FIFO order. */
  readonly #ready: Array<(isGranted: boolean) => void> = [];
  /** The running job of each key, from enqueue until it ends. */
  readonly #jobs = new Map<string, Promise<void>>();
  readonly #abort = new AbortController();
  readonly #aborted: Promise<void>;
  #isSending = false;
  #stopped = false;

  constructor(opts: ChannelDeliveryOptions) {
    this.#opts = opts;
    this.#aborted = new Promise((resolve) => {
      this.#abort.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  /**
   * Adds a job, with the recipient progress stored for a recovered pending key. A key that already
   * has a job is ignored.
   */
  enqueue(notification: Notification, progress?: RecipientProgress): void {
    if (this.#stopped || this.#jobs.has(notification.key)) return;
    const key = notification.key;
    const start = {
      delivered: [...(progress?.delivered ?? [])],
      refused: [...(progress?.refused ?? [])],
    };
    const job = this.#run(notification, start).finally(() => {
      this.#jobs.delete(key);
      this.#opts.release?.(key);
    });
    this.#jobs.set(key, job);
  }

  /** Resolves when no job is ready, sending or waiting. */
  async idle(): Promise<void> {
    while (this.#jobs.size > 0) await Promise.all(this.#jobs.values());
  }

  /** Drops the ready jobs and aborts the send in flight and every retry timer. */
  stop(): void {
    this.#stopped = true;
    for (const grant of this.#ready.splice(0)) grant(false);
    this.#abort.abort();
  }

  /**
   * Takes the channel when it is free and nothing is ready. This runs synchronously, so a first
   * claim happens within `enqueue`, as the ledger write order expects.
   */
  #takeTurn(): boolean {
    if (this.#stopped || this.#isSending || this.#ready.length > 0) return false;
    this.#isSending = true;
    return true;
  }

  /** Waits at the end of the ready queue; false when the channel stopped first. */
  #waitTurn(): Promise<boolean> {
    if (this.#stopped) return Promise.resolve(false);
    return new Promise((resolve) => this.#ready.push(resolve));
  }

  #endTurn(): void {
    const next = this.#ready.shift();
    this.#isSending = next !== undefined;
    next?.(true);
  }

  async #run(notification: Notification, progress: RecipientProgress): Promise<void> {
    try {
      if (!this.#takeTurn() && !(await this.#waitTurn())) return;
      let isClaimed = false;
      try {
        isClaimed = this.#claim(notification);
      } finally {
        if (!isClaimed) this.#endTurn();
      }
      if (!isClaimed) return;
      const outcome = await this.#attempts(notification, progress);
      if (outcome.kind !== "stopped") this.#settle(notification, outcome);
    } catch (err) {
      this.#opts.logger.error("delivery failed unexpectedly", {
        channel: this.#opts.channelId,
        key: notification.key,
        ...errorFields(err),
      });
    }
  }
  /** A key that is already pending is a resend after a restart. */
  #claim(notification: Notification): boolean {
    const { channelId, ledger, logger } = this.#opts;
    const status = ledger.status(channelId, notification.key);
    if (status === "pending") return true;
    if (status !== undefined) return false;
    try {
      return ledger.claim(channelId, notification.key, notification);
    } catch (err) {
      logger.error("ledger claim failed, the next poll retries", {
        channel: channelId,
        key: notification.key,
        ...errorFields(err),
      });
      return false;
    }
  }

  /** Runs the attempts of a job. It holds the turn on entry and gives it up after each send. */
  async #attempts(notification: Notification, start: RecipientProgress): Promise<Outcome> {
    const { channelId, logger } = this.#opts;
    const initial = this.#opts.retryDelayMs;
    const max = Math.max(this.#opts.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS, initial);
    const limit = this.#opts.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
    let progress = start;
    for (let attempt = 1; ; attempt++) {
      const result = await this.#attempt(notification, progress, attempt, limit);
      if (result.progress) progress = result.progress;
      if (result.outcome) return result.outcome;
      if (!(result.error instanceof PartialDeliveryError)) {
        logger.warn("delivery attempt failed", {
          channel: channelId,
          key: notification.key,
          attempt,
          ...errorFields(result.error),
        });
      }
      await this.#wait(retryDelay(attempt, initial, max));
      if (!this.#takeTurn() && !(await this.#waitTurn())) return { kind: "stopped" };
    }
  }

  /** One attempt within the turn; the turn ends before it returns. */
  async #attempt(
    notification: Notification,
    progress: RecipientProgress,
    attempt: number,
    limit: number,
  ): Promise<AttemptResult> {
    try {
      if (this.#stopped) return { outcome: { kind: "stopped" } };
      if (this.#opts.isStale?.(notification)) return { outcome: { kind: "dropped" } };
      await this.#opts.send(notification, this.#abort.signal, progress);
      return { outcome: { kind: "delivered", attempts: attempt } };
    } catch (err) {
      if (this.#stopped) return { outcome: { kind: "stopped" } };
      const partial =
        err instanceof PartialDeliveryError
          ? this.#recordPartial(notification, err, attempt)
          : undefined;
      const failed = failureOf(err, attempt, limit);
      return failed ? { outcome: failed, progress: partial } : { error: err, progress: partial };
    } finally {
      this.#endTurn();
    }
  }

  /**
   * Logs a partly refused attempt and stores its progress. A failed write keeps the progress in
   * memory, so the next attempt in this process still skips the delivered recipients.
   */
  #recordPartial(
    notification: Notification,
    err: PartialDeliveryError,
    attempt: number,
  ): RecipientProgress {
    const { channelId, ledger, logger } = this.#opts;
    const progress = {
      delivered: [...err.progress.delivered],
      refused: [...err.progress.refused],
    };
    logger.warn("delivery attempt partly refused", {
      channel: channelId,
      key: notification.key,
      attempt,
      delivered: progress.delivered.length,
      refused: progress.refused.length,
      remaining: err.remaining,
      codes: err.codes,
    });
    try {
      ledger.setRecipients(channelId, notification.key, progress);
    } catch (err) {
      logger.error("ledger recipient write failed", {
        channel: channelId,
        key: notification.key,
        ...errorFields(err),
      });
    }
    return progress;
  }

  async #wait(ms: number): Promise<void> {
    await Promise.race([this.#opts.sleep(ms, this.#abort.signal), this.#aborted]);
  }

  #settle(notification: Notification, outcome: Exclude<Outcome, { kind: "stopped" }>): void {
    const { channelId, ledger, logger } = this.#opts;
    try {
      ledger.settle(channelId, notification.key, outcome.kind);
    } catch (err) {
      // The key stays pending and is resent at the next start.
      logger.error("ledger settle failed, the key stays pending", {
        channel: channelId,
        key: notification.key,
        ...errorFields(err),
      });
      return;
    }
    if (outcome.kind === "dropped") {
      logger.info("stale reminder dropped", { channel: channelId, key: notification.key });
      return;
    }
    this.#opts.onOutcome?.(outcome.kind);
    if (outcome.kind === "delivered") {
      logger.info("notification delivered", {
        channel: channelId,
        key: notification.key,
        attempts: outcome.attempts,
      });
    } else {
      logger.error("notification delivery failed", {
        channel: channelId,
        key: notification.key,
        attempts: outcome.attempts,
        ...(outcome.isPermanent ? { permanent: true, note: "permanent error, not retried" } : {}),
        ...errorFields(outcome.error),
      });
    }
  }
}
