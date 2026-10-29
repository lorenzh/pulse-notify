import type { Check, Incident } from "@lorenzh/pulse-contract";
import { fetchChecks, fetchIncidents } from "./api.ts";
import { createSender } from "./channels/factory.ts";
import { isRouted } from "./channels/routing.ts";
import type { SendMail } from "./channels/smtp.ts";
import { ChannelDelivery } from "./delivery.ts";
import { detectEvents, eventTimeMs, type ReminderPlan, seedKeys } from "./detector.ts";
import { errorFields } from "./errors.ts";
import type { Ledger } from "./ledger.ts";
import type { Logger } from "./log.ts";
import type { Metrics } from "./metrics.ts";
import { defaultSchedule } from "./timeout.ts";
import type {
  ChannelConfig,
  Config,
  Notification,
  NotificationEvent,
  Schedule,
  Sleep,
} from "./types.ts";

export interface NotifierOptions {
  config: Config;
  apiUrl: string;
  ledger: Ledger;
  logger: Logger;
  pollMs?: number;
  /** Delay before the first retry; it doubles up to `retryMaxDelayMs`. */
  retryDelayMs?: number;
  retryMaxDelayMs?: number | undefined;
  /** Total attempts per event; 0 retries without end. */
  retryAttempts?: number | undefined;
  timeoutMs?: number | undefined;
  fetch?: typeof fetch | undefined;
  /** Waits between delivery attempts. */
  sleep?: Sleep;
  /** Schedules the next poll and request timeouts. */
  schedule?: Schedule;
  metrics?: Metrics;
  /** Clock for reminders and signatures. */
  now?: () => number;
  /** Replaces the SMTP client, for tests. */
  sendMail?: SendMail;
}

const realSleep: Sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

interface ChannelState {
  config: ChannelConfig;
  delivery: ChannelDelivery;
  /** Keys enqueued but not yet recorded in the ledger. */
  queued: Set<string>;
}

function buildNotification(
  key: string,
  event: NotificationEvent,
  incident: Incident,
  names: Map<string, string>,
  nowMs: number,
): Notification {
  const timeMs = eventTimeMs(event, incident, nowMs);
  return {
    key,
    event,
    incidentId: incident.id,
    checkId: incident.checkId,
    checkName: names.get(incident.checkId) ?? incident.checkId,
    reason: incident.reason ?? null,
    time: new Date(timeMs).toISOString(),
    timeMs,
    openedMs: incident.openedAt,
  };
}

type BuildArgs = Parameters<typeof buildNotification>;

function buildArgs(...args: BuildArgs): BuildArgs {
  return args;
}

export class Notifier {
  readonly #opts: NotifierOptions;
  readonly #channels: ChannelState[];
  /** Incident ids and legacy keys already reported, so a bad item is logged once. */
  readonly #reported = new Set<string>();
  /** Ids of the incidents that the last poll showed as resolved. */
  #resolved = new Set<number>();
  readonly #now: () => number;
  #cancelPoll: (() => void) | undefined;
  #running = false;
  #ticking: Promise<void> | undefined;

  constructor(opts: NotifierOptions) {
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
    const schedule = opts.schedule ?? defaultSchedule;
    this.#channels = opts.config.channels.map((config) => {
      const send = createSender(config, {
        fetch: opts.fetch,
        timeoutMs: opts.timeoutMs,
        schedule,
        now: this.#now,
        logger: opts.logger,
        sendMail: opts.sendMail,
      });
      const queued = new Set<string>();
      return {
        config,
        queued,
        delivery: new ChannelDelivery({
          channelId: config.id,
          send,
          ledger: opts.ledger,
          sleep: opts.sleep ?? realSleep,
          retryDelayMs: opts.retryDelayMs ?? 1000,
          retryMaxDelayMs: opts.retryMaxDelayMs,
          retryAttempts: opts.retryAttempts,
          logger: opts.logger,
          release: (key) => queued.delete(key),
          isStale: (n) => n.event === "reminder" && this.#resolved.has(n.incidentId),
          onOutcome: (outcome) =>
            opts.metrics?.deliveryDone(config.id, outcome === "delivered" ? "success" : "failure"),
        }),
      };
    });
  }

  /** Resends pending notifications from the ledger, then starts polling (first poll at delay 0). */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#resendPending();
    this.#scheduleNext(0);
  }

  /**
   * Stops polling, aborts sleeps and sends in flight and resolves when the workers are done.
   * Unfinished keys stay `pending` in the ledger.
   */
  async stop(): Promise<void> {
    this.#running = false;
    this.#cancelPoll?.();
    this.#cancelPoll = undefined;
    for (const channel of this.#channels) channel.delivery.stop();
    await this.idle();
  }

  /** Resolves when every channel queue is empty. */
  async idle(): Promise<void> {
    await Promise.all(this.#channels.map((c) => c.delivery.idle()));
  }

  #resendPending(): void {
    const counts = new Map<string, number>();
    for (const { channelId, key, notification } of this.#opts.ledger.pending()) {
      const channel = this.#channels.find((c) => c.config.id === channelId);
      if (!channel || !notification) continue;
      channel.queued.add(key);
      channel.delivery.enqueue(notification);
      counts.set(channelId, (counts.get(channelId) ?? 0) + 1);
    }
    for (const [channel, count] of counts) {
      this.#opts.logger.log("info", "resending pending notifications", { channel, count });
    }
  }

  #scheduleNext(ms: number): void {
    if (!this.#running) return;
    const schedule = this.#opts.schedule ?? defaultSchedule;
    this.#cancelPoll = schedule(() => {
      this.tick()
        .catch(() => {
          // tick() never rejects; this keeps the loop alive if that ever changes.
        })
        .finally(() => this.#scheduleNext(this.#opts.pollMs ?? 5000));
    }, ms);
  }

  /** One poll: fetch, detect, enqueue. Never rejects; does not wait for deliveries. */
  tick(): Promise<void> {
    this.#ticking ??= this.#poll()
      .catch((err: unknown) => {
        this.#opts.logger.log("error", "poll failed unexpectedly", errorFields(err));
      })
      .finally(() => {
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
      onVersionAbsent: () => this.#reportVersionAbsent(),
      onInvalidCheck: (error: string) => this.#reportInvalidCheck(error),
    };
    let incidents: Incident[];
    let checks: Check[];
    try {
      const [result, fetched] = await Promise.all([fetchIncidents(api), fetchChecks(api)]);
      incidents = result.incidents;
      checks = fetched;
      this.#reportRejected(result.rejected);
    } catch (err) {
      this.#opts.logger.log("error", "api poll failed", errorFields(err));
      this.#opts.metrics?.pollDone("error");
      return;
    }
    this.#opts.metrics?.pollDone("ok");
    const names = new Map(checks.map((c) => [c.id, c.name]));
    // Before any enqueue, so a reminder that is queued when its incident resolves is dropped.
    this.#resolved = new Set(incidents.filter((i) => i.resolvedAt != null).map((i) => i.id));
    const nowMs = this.#now();
    for (const channel of this.#channels) {
      this.#pollChannel(channel, incidents, names, nowMs);
    }
  }

  #reportVersionAbsent(): void {
    if (this.#reported.has("wire-version-absent")) return;
    this.#reported.add("wire-version-absent");
    this.#opts.logger.log("warn", "api sent no wire version header; continuing");
  }

  #reportInvalidCheck(error: string): void {
    const key = `check:${error}`;
    if (this.#reported.has(key)) return;
    this.#reported.add(key);
    this.#opts.logger.log("warn", "check skipped: malformed data", { reason: error });
  }

  #reportRejected(rejected: { id: unknown; reason: string }[]): void {
    for (const { id, reason } of rejected) {
      const key = `incident:${String(id)}`;
      if (this.#reported.has(key)) continue;
      this.#reported.add(key);
      this.#opts.logger.log("error", "incident skipped: malformed data", {
        incidentId: id,
        reason,
      });
    }
  }

  #pollChannel(
    channel: ChannelState,
    incidents: Incident[],
    names: Map<string, string>,
    nowMs: number,
  ): void {
    const { ledger, logger } = this.#opts;
    const id = channel.config.id;
    const remindSeconds = channel.config.remindEverySeconds;
    const reminders: ReminderPlan | undefined =
      remindSeconds === undefined ? undefined : { everyMs: remindSeconds * 1000, nowMs };
    if (!ledger.hasChannel(id)) {
      try {
        ledger.seed(id, seedKeys(incidents, reminders));
      } catch (err) {
        logger.log("error", "ledger seed failed, the next poll retries", {
          channel: id,
          ...errorFields(err),
        });
        return;
      }
      logger.log("info", "channel seeded with existing incidents", {
        channel: id,
        incidents: incidents.length,
      });
      return;
    }
    this.#rebuildLegacyPending(channel, incidents, names, nowMs);
    const relevant = incidents.filter((i) => isRouted(channel.config, i.checkId));
    const events = detectEvents(
      relevant,
      (key) => ledger.has(id, key) || channel.queued.has(key),
      reminders,
    );
    for (const { key, event, incident } of events) {
      this.#enqueue(channel, buildArgs(key, event, incident, names, nowMs));
    }
  }

  /** Pending keys from an older version have no stored notification: rebuild it from the API. */
  #rebuildLegacyPending(
    channel: ChannelState,
    incidents: Incident[],
    names: Map<string, string>,
    nowMs: number,
  ): void {
    const id = channel.config.id;
    for (const { channelId, key, notification } of this.#opts.ledger.pending()) {
      if (channelId !== id || notification || channel.queued.has(key)) continue;
      const found = this.#findEvent(key, incidents);
      if (!found) {
        const reportKey = `legacy:${id}:${key}`;
        if (this.#reported.has(reportKey)) continue;
        this.#reported.add(reportKey);
        this.#opts.logger.log(
          "error",
          "pending notification cannot be rebuilt: incident not found",
          {
            channel: id,
            key,
          },
        );
        continue;
      }
      this.#enqueue(channel, buildArgs(key, found.event, found.incident, names, nowMs));
    }
  }

  /**
   * Builds first, so a build error leaves the key unqueued and the next poll tries again.
   * Only the build is caught: errors from `enqueue` must surface.
   */
  #enqueue(channel: ChannelState, args: BuildArgs): void {
    let notification: Notification;
    try {
      notification = buildNotification(...args);
    } catch (err) {
      this.#opts.logger.log("error", "notification cannot be built, the next poll retries", {
        channel: channel.config.id,
        key: args[0],
        ...errorFields(err),
      });
      return;
    }
    channel.queued.add(args[0]);
    channel.delivery.enqueue(notification);
  }

  #findEvent(
    key: string,
    incidents: Incident[],
  ): { event: NotificationEvent; incident: Incident } | undefined {
    const [rawId, event] = key.split(":");
    if (event !== "opened" && event !== "resolved") return undefined;
    const incident = incidents.find((i) => String(i.id) === rawId);
    if (!incident || (event === "resolved" && incident.resolvedAt == null)) return undefined;
    return { event, incident };
  }
}
