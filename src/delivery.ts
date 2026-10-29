import { errorFields } from "./errors.ts";
import type { Ledger } from "./ledger.ts";
import type { Logger } from "./log.ts";
import type { Notification, Sender, Sleep } from "./types.ts";

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
  retryMaxDelayMs?: number;
  /** Total attempts per event; 0 retries without end. */
  retryAttempts?: number;
  logger: Logger;
  /** Called when a notification leaves the worker, whatever the outcome. */
  release?: (key: string) => void;
}

type Outcome =
  | { kind: "delivered"; attempts: number }
  | { kind: "failed"; attempts: number; error: unknown }
  | { kind: "stopped" };

/** Delay before retry `n` (1, 2, ...): `min(initial * 2^(n-1), max)`. */
export function retryDelay(n: number, initialMs: number, maxMs: number): number {
  return Math.min(initialMs * 2 ** (n - 1), maxMs);
}

/** One FIFO queue and worker for a channel. */
export class ChannelDelivery {
  readonly #opts: ChannelDeliveryOptions;
  readonly #queue: Notification[] = [];
  readonly #abort = new AbortController();
  readonly #aborted: Promise<void>;
  #running: Promise<void> | undefined;
  #stopped = false;

  constructor(opts: ChannelDeliveryOptions) {
    this.#opts = opts;
    this.#aborted = new Promise((resolve) => {
      this.#abort.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  enqueue(notification: Notification): void {
    if (this.#stopped) return;
    this.#queue.push(notification);
    this.#running ??= this.#drain().finally(() => {
      this.#running = undefined;
    });
  }

  /** Resolves when the queue is empty and nothing is being sent. */
  async idle(): Promise<void> {
    while (this.#running) await this.#running;
  }

  /** Drops the queue and aborts the sleep and the send in flight. Await `idle()` for the end. */
  stop(): void {
    this.#stopped = true;
    this.#queue.length = 0;
    this.#abort.abort();
  }

  async #drain(): Promise<void> {
    while (!this.#stopped) {
      const next = this.#queue.shift();
      if (!next) return;
      try {
        await this.#deliver(next);
      } catch (err) {
        this.#opts.logger.log("error", "delivery failed unexpectedly", {
          channel: this.#opts.channelId,
          key: next.key,
          ...errorFields(err),
        });
      } finally {
        this.#opts.release?.(next.key);
      }
    }
  }

  async #deliver(notification: Notification): Promise<void> {
    if (!this.#claim(notification)) return;
    const outcome = await this.#attempts(notification);
    if (outcome.kind !== "stopped") this.#settle(notification, outcome);
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
      logger.log("error", "ledger claim failed, the next poll retries", {
        channel: channelId,
        key: notification.key,
        ...errorFields(err),
      });
      return false;
    }
  }

  async #attempts(notification: Notification): Promise<Outcome> {
    const { channelId, send, sleep, logger } = this.#opts;
    const initial = this.#opts.retryDelayMs;
    const max = Math.max(this.#opts.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS, initial);
    const limit = this.#opts.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
    for (let attempt = 1; ; attempt++) {
      if (this.#stopped) return { kind: "stopped" };
      try {
        await send(notification, this.#abort.signal);
        return { kind: "delivered", attempts: attempt };
      } catch (err) {
        if (this.#stopped) return { kind: "stopped" };
        if (limit > 0 && attempt >= limit) return { kind: "failed", attempts: attempt, error: err };
        logger.log("warn", "delivery attempt failed", {
          channel: channelId,
          key: notification.key,
          attempt,
          ...errorFields(err),
        });
        await Promise.race([
          sleep(retryDelay(attempt, initial, max), this.#abort.signal),
          this.#aborted,
        ]);
      }
    }
  }

  #settle(notification: Notification, outcome: Exclude<Outcome, { kind: "stopped" }>): void {
    const { channelId, ledger, logger } = this.#opts;
    try {
      ledger.settle(channelId, notification.key, outcome.kind);
    } catch (err) {
      // The key stays pending and is resent at the next start.
      logger.log("error", "ledger settle failed, the key stays pending", {
        channel: channelId,
        key: notification.key,
        ...errorFields(err),
      });
      return;
    }
    if (outcome.kind === "delivered") {
      logger.log("info", "notification delivered", {
        channel: channelId,
        key: notification.key,
        attempts: outcome.attempts,
      });
    } else {
      logger.log("error", "notification delivery failed", {
        channel: channelId,
        key: notification.key,
        attempts: outcome.attempts,
        ...errorFields(outcome.error),
      });
    }
  }
}
