import type { Check, Incident } from "@lorenzh/pulse-contract";
import { fetchChecks, fetchIncidents } from "./api.ts";
import { createFileSender } from "./channels/file.ts";
import { createWebhookSender } from "./channels/webhook.ts";
import { ChannelDelivery } from "./delivery.ts";
import { detectEvents, seedKeys } from "./detector.ts";
import type { Ledger } from "./ledger.ts";
import type { Logger } from "./log.ts";
import { defaultSchedule } from "./timeout.ts";
import type { ChannelConfig, Config, Notification, Schedule, Sender, Sleep } from "./types.ts";

export interface NotifierOptions {
  config: Config;
  apiUrl: string;
  ledger: Ledger;
  logger: Logger;
  pollMs?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Waits between delivery attempts. */
  sleep?: Sleep;
  /** Schedules the next poll and request timeouts. */
  schedule?: Schedule;
}

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

interface ChannelState {
  config: ChannelConfig;
  delivery: ChannelDelivery;
  /** Keys enqueued but not yet recorded in the ledger. */
  queued: Set<string>;
}

export class Notifier {
  readonly #opts: NotifierOptions;
  readonly #channels: ChannelState[];
  #cancelPoll: (() => void) | undefined;
  #running = false;
  #ticking: Promise<void> | undefined;

  constructor(opts: NotifierOptions) {
    this.#opts = opts;
    const schedule = opts.schedule ?? defaultSchedule;
    this.#channels = opts.config.channels.map((config) => {
      const send: Sender =
        config.type === "webhook"
          ? createWebhookSender(config, {
              fetch: opts.fetch,
              timeoutMs: opts.timeoutMs,
              schedule,
            })
          : createFileSender(config);
      return {
        config,
        queued: new Set<string>(),
        delivery: new ChannelDelivery({
          channelId: config.id,
          send,
          ledger: opts.ledger,
          sleep: opts.sleep ?? realSleep,
          retryDelayMs: opts.retryDelayMs ?? 1000,
          logger: opts.logger,
        }),
      };
    });
  }

  /** Logs stale claims and starts the poll loop (first poll is scheduled with delay 0). */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    for (const { channelId, key } of this.#opts.ledger.pending()) {
      this.#opts.logger.log("error", "notification possibly lost: claimed but never settled", {
        channel: channelId,
        key,
      });
    }
    this.#scheduleNext(0);
  }

  stop(): void {
    this.#running = false;
    this.#cancelPoll?.();
    this.#cancelPoll = undefined;
    for (const channel of this.#channels) channel.delivery.stop();
  }

  /** Resolves when every channel queue is empty. */
  async idle(): Promise<void> {
    await Promise.all(this.#channels.map((c) => c.delivery.idle()));
  }

  #scheduleNext(ms: number): void {
    if (!this.#running) return;
    const schedule = this.#opts.schedule ?? defaultSchedule;
    this.#cancelPoll = schedule(() => {
      void this.tick().finally(() => this.#scheduleNext(this.#opts.pollMs ?? 5000));
    }, ms);
  }

  /** One poll: fetch, detect, enqueue. Never throws; does not wait for deliveries. */
  tick(): Promise<void> {
    this.#ticking ??= this.#poll().finally(() => {
      this.#ticking = undefined;
    });
    return this.#ticking;
  }

  async #poll(): Promise<void> {
    const api = {
      baseUrl: this.#opts.apiUrl,
      fetch: this.#opts.fetch,
      timeoutMs: this.#opts.timeoutMs,
      schedule: this.#opts.schedule,
    };
    let incidents: Incident[];
    let checks: Check[];
    try {
      [incidents, checks] = await Promise.all([fetchIncidents(api), fetchChecks(api)]);
    } catch (err) {
      this.#opts.logger.log("error", "api poll failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const names = new Map(checks.map((c) => [c.id, c.name]));
    const { ledger } = this.#opts;
    for (const channel of this.#channels) {
      const id = channel.config.id;
      if (!ledger.hasChannel(id)) {
        ledger.seed(id, seedKeys(incidents));
        this.#opts.logger.log("info", "channel seeded with existing incidents", {
          channel: id,
          incidents: incidents.length,
        });
        continue;
      }
      const filter = channel.config.checks;
      const relevant =
        filter && filter.length > 0
          ? incidents.filter((i) => filter.includes(i.checkId))
          : incidents;
      const events = detectEvents(
        relevant,
        (key) => ledger.has(id, key) || channel.queued.has(key),
      );
      for (const { key, event, incident } of events) {
        const timeMs = event === "opened" ? incident.openedAt : (incident.resolvedAt as number);
        const notification: Notification = {
          key,
          event,
          incidentId: incident.id,
          checkId: incident.checkId,
          checkName: names.get(incident.checkId) ?? incident.checkId,
          reason: incident.reason ?? null,
          time: new Date(timeMs).toISOString(),
          timeMs,
        };
        channel.queued.add(key);
        channel.delivery.enqueue(notification);
      }
    }
  }
}
