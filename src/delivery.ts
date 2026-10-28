import type { Ledger } from "./ledger.ts";
import type { Logger } from "./log.ts";
import type { Notification, Sender, Sleep } from "./types.ts";

export const MAX_ATTEMPTS = 4;

export interface ChannelDeliveryOptions {
  channelId: string;
  send: Sender;
  ledger: Ledger;
  sleep: Sleep;
  retryDelayMs: number;
  logger: Logger;
}

/** One FIFO queue and worker for a channel. */
export class ChannelDelivery {
  readonly #opts: ChannelDeliveryOptions;
  readonly #queue: Notification[] = [];
  #running: Promise<void> | undefined;
  #stopped = false;

  constructor(opts: ChannelDeliveryOptions) {
    this.#opts = opts;
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

  stop(): void {
    this.#stopped = true;
    this.#queue.length = 0;
  }

  async #drain(): Promise<void> {
    while (!this.#stopped) {
      const next = this.#queue.shift();
      if (!next) return;
      await this.#deliver(next);
    }
  }

  async #deliver(notification: Notification): Promise<void> {
    const { channelId, send, ledger, sleep, retryDelayMs, logger } = this.#opts;
    if (!ledger.claim(channelId, notification.key)) return;
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await send(notification);
        ledger.settle(channelId, notification.key, "delivered");
        logger.log("info", "notification delivered", {
          channel: channelId,
          key: notification.key,
          attempts: attempt,
        });
        return;
      } catch (err) {
        lastError = err;
        if (attempt < MAX_ATTEMPTS) {
          logger.log("warn", "delivery attempt failed", {
            channel: channelId,
            key: notification.key,
            attempt,
            error: errorMessage(err),
          });
          await sleep(retryDelayMs);
          if (this.#stopped) return;
        }
      }
    }
    ledger.settle(channelId, notification.key, "failed");
    logger.log("error", "notification delivery failed", {
      channel: channelId,
      key: notification.key,
      attempts: MAX_ATTEMPTS,
      error: errorMessage(lastError),
    });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
