import type { Incident, ManualIncident } from "@lorenzh/pulse-contract";
import type { Logger } from "@lorenzh/pulse-kit";
import { type AlertInputs, isSubscribed, planAlerts } from "./alert-poll.ts";
import {
  ApiReadError,
  fetchChecksWithState,
  fetchComponents,
  fetchIncidents,
  fetchManualIncidents,
  type ManualIncidentsResult,
  type RejectedIncident,
} from "./api.ts";
import { BoundedSet } from "./bounded-set.ts";
import { createSender } from "./channels/factory.ts";
import type { SendMail } from "./channels/mailer.ts";
import {
  checkRouting,
  componentRouting,
  isManualRouted,
  isRouted,
  parseCheckRouting,
  parseComponentRouting,
} from "./channels/routing.ts";
import { ChannelDelivery } from "./delivery.ts";
import {
  type DetectedManualEvent,
  detectEvents,
  detectManualEvents,
  eventTimeMs,
  type ReminderPlan,
  seedKeys,
  seedManualKeys,
} from "./detector.ts";
import { errorFields } from "./errors.ts";
import type { AlertDelivery, Ledger } from "./ledger.ts";
import type { FeedName, Metrics } from "./metrics.ts";
import { defaultSchedule } from "./timeout.ts";
import type {
  ChannelConfig,
  Config,
  IncidentNotification,
  Notification,
  NotificationEvent,
  RecipientProgress,
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
  /** Largest API response body in bytes. */
  apiMaxBytes?: number | undefined;
  /** Settled ledger entries older than this many days are pruned. Default 30. */
  stateRetentionDays?: number | undefined;
  /** Global EHLO name for email channels. */
  smtpClientName?: string | undefined;
  /** Machine host name, the EHLO name when nothing is set. */
  hostname?: (() => string) | undefined;
  /** A budget-low warning fires below this percent of error budget left. Default 25. */
  budgetThreshold?: number | undefined;
}

export class IncidentDropError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      "cannot drop pending incident notifications of channels with sendIncidents false",
      options,
    );
    this.name = "IncidentDropError";
  }
}

/** How a notifier polls: used for the health check. */
export interface PollHealth {
  /** Polls in a row that failed (a feed read or detection threw); 0 after a good poll. */
  consecutiveFailedPolls: number;
}

/** Most malformed-item identities remembered, so a bad item is logged once without unbounded memory. */
export const MALFORMED_REPORT_LIMIT = 1024;

const DAY_MS = 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

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
  /** Pending reminders from the ledger, held until the first successful poll. */
  held: { notification: Notification; recipients: RecipientProgress | undefined }[];
}

const REMINDER_KEY = /^(\d+):reminder:(\d+)$/;

function buildNotification(
  key: string,
  event: NotificationEvent,
  incident: Incident,
  names: Map<string, string>,
  nowMs: number,
): IncidentNotification {
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

function buildManualNotification(detected: DetectedManualEvent): IncidentNotification {
  const { incident, event, key, timeMs, updateIndex } = detected;
  const update = incident.updates[updateIndex];
  const message = event === "resolved" ? (incident.updates.at(-1)?.message ?? "") : update?.message;
  if (message === undefined) throw new Error(`manual incident ${incident.id} has no update`);
  return {
    key,
    event,
    incidentId: incident.id,
    checkId: "",
    checkName: incident.title,
    reason: null,
    time: new Date(timeMs).toISOString(),
    timeMs,
    openedMs: incident.createdAt,
    manual: {
      impact: incident.impact,
      status: event === "resolved" ? "resolved" : (update?.status ?? incident.status),
      message,
      componentIds: incident.componentIds,
    },
  };
}

type BuildArgs = Parameters<typeof buildNotification>;

function buildArgs(...args: BuildArgs): BuildArgs {
  return args;
}

export class Notifier {
  readonly #opts: NotifierOptions;
  readonly #channels: ChannelState[];
  /** Identities of malformed api items already logged (`<feed>:id:<id>` or `<feed>:index:<n>`). */
  readonly #malformed = new BoundedSet(MALFORMED_REPORT_LIMIT);
  /** Legacy pending keys already reported; they come from the local ledger, not the api. */
  readonly #legacyReported = new Set<string>();
  #isVersionAbsentReported = false;
  /** Ids of the incidents that the last poll showed as resolved. */
  #resolved = new Set<number>();
  readonly #now: () => number;
  #failedPolls = 0;
  /** Ids of the incidents in the last successful poll; `undefined` before the first one. */
  #visible: Set<number> | undefined;
  /** Ids of the manual incidents in the last successful read; kept on 404 or a failed read. */
  #visibleManual: Set<number> | undefined;
  /** Check names from the last good `/checks` read; kept while that read fails. */
  #checkNames = new Map<string, string>();
  /** Failure kinds already logged per feed; cleared when the feed answers again. */
  readonly #feedFailures = new Map<FeedName, Set<string>>();
  #lastPruneMs: number | undefined;
  #lastAlertPruneMs: number | undefined;
  /** Subject ids of the last good `/checks` and `/components` reads, for alert pruning. */
  readonly #alertPresence: { checks?: Set<string>; components?: Set<string> } = {};
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
        smtpClientName: opts.smtpClientName,
        hostname: opts.hostname,
      });
      const queued = new Set<string>();
      const state: ChannelState = {
        config,
        queued,
        held: [],
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
          isStale: (n) =>
            n.event === "reminder" &&
            (this.#resolved.has(n.incidentId) || this.#isSuperseded(state, n)),
          onOutcome: (outcome) =>
            opts.metrics?.deliveryDone(config.id, outcome === "delivered" ? "success" : "failure"),
        }),
      };
      return state;
    });
    this.#dropIncidentsOfWarningOnly();
  }

  /** Before any send: a channel with `sendIncidents: false` never sends a stored incident. */
  #dropIncidentsOfWarningOnly(): void {
    const ids = this.#opts.config.channels
      .filter((c) => c.sendIncidents === false)
      .map((c) => c.id);
    if (ids.length === 0) return;
    let counts: Map<string, number>;
    try {
      counts = this.#opts.ledger.dropPendingIncidents(ids);
    } catch (err) {
      throw new IncidentDropError({ cause: err });
    }
    for (const [channel, count] of counts) {
      if (count > 0) {
        this.#opts.logger.info("incident notifications dropped: channel sends no incidents", {
          channel,
          count,
        });
      }
    }
  }

  /** True when a reminder of the same incident with a higher n is queued or in the ledger with any status except dropped. */
  #isSuperseded(channel: ChannelState, notification: Notification): boolean {
    const own = REMINDER_KEY.exec(notification.key);
    if (!own) return false;
    const isNewer = (key: string, status: string): boolean => {
      const match = REMINDER_KEY.exec(key);
      return (
        match !== null &&
        match[1] === own[1] &&
        Number(match[2]) > Number(own[2]) &&
        status !== "dropped"
      );
    };
    for (const key of channel.queued) if (isNewer(key, "pending")) return true;
    return this.#opts.ledger.entries(channel.config.id).some(([k, s]) => isNewer(k, s));
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

  pollHealth(): PollHealth {
    return { consecutiveFailedPolls: this.#failedPolls };
  }

  /** Resolves when every channel queue is empty. */
  async idle(): Promise<void> {
    await Promise.all(this.#channels.map((c) => c.delivery.idle()));
  }

  #resendPending(): void {
    const counts = new Map<string, number>();
    for (const { channelId, key, notification, recipients } of this.#opts.ledger.pending()) {
      const channel = this.#channels.find((c) => c.config.id === channelId);
      if (!channel || !notification) continue;
      if (notification.event === "reminder") {
        // Held until a poll shows which incidents are resolved.
        channel.held.push({ notification, recipients });
        continue;
      }
      channel.queued.add(key);
      channel.delivery.enqueue(notification, recipients);
      counts.set(channelId, (counts.get(channelId) ?? 0) + 1);
    }
    for (const [channel, count] of counts) {
      this.#opts.logger.info("resending pending notifications", { channel, count });
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
      .then((isOk) => {
        this.#failedPolls = isOk ? 0 : this.#failedPolls + 1;
      })
      .catch((err: unknown) => {
        this.#failedPolls++;
        this.#opts.logger.error("poll failed unexpectedly", errorFields(err));
      })
      .finally(() => {
        this.#ticking = undefined;
      });
    return this.#ticking;
  }

  /**
   * Reads the three feeds in parallel; each one that answered is used even when another failed.
   * Resolves true only when all three answered (a 404 on manual incidents counts).
   */
  async #poll(): Promise<boolean> {
    const api = {
      baseUrl: this.#opts.apiUrl,
      fetch: this.#opts.fetch,
      timeoutMs: this.#opts.timeoutMs,
      maxBytes: this.#opts.apiMaxBytes,
      schedule: this.#opts.schedule,
      onVersionAbsent: () => this.#reportVersionAbsent(),
      onInvalidCheck: (index: number) => this.#reportInvalidCheck(index),
      onInvalidComponent: (index: number) => this.#reportInvalidComponent(index),
    };
    const channels = this.#opts.config.channels;
    const hasAlerts = channels.some((c) => (c.alerts ?? []).length > 0);
    const hasBudget = isSubscribed(channels, "budget-low");
    const [incidentsRead, checksRead, manualRead, componentsRead] = await Promise.allSettled([
      fetchIncidents(api),
      fetchChecksWithState(api, hasAlerts),
      fetchManualIncidents(api),
      hasBudget ? fetchComponents(api) : Promise.resolve(undefined),
    ]);
    const result = this.#feedValue("incidents", incidentsRead);
    const checksResult = this.#feedValue("checks", checksRead);
    const checks = checksResult?.checks;
    const manualResult = this.#feedValue("manual-incidents", manualRead);
    const components = hasBudget ? this.#feedValue("components", componentsRead) : undefined;
    const isComponentsOk = !hasBudget || componentsRead.status === "fulfilled";
    const isOk =
      result !== undefined && checks !== undefined && manualResult !== undefined && isComponentsOk;
    this.#opts.metrics?.pollDone(isOk ? "ok" : "error");
    if (result) this.#reportRejected("incidents", result.rejected);
    if (manualResult) {
      this.#reportRejected("manual-incidents", manualResult.rejected);
      if (!manualResult.isAbsent) {
        this.#visibleManual = new Set(manualResult.incidents.map((i) => i.id));
      }
    }
    if (checks) this.#checkNames = new Map(checks.map((c) => [c.id, c.name]));
    const incidents = result?.incidents;
    // Before any enqueue, so a reminder that is queued when its incident resolves is dropped.
    if (incidents) {
      this.#resolved = new Set(incidents.filter((i) => i.resolvedAt != null).map((i) => i.id));
    }
    const nowMs = this.#now();
    for (const channel of this.#channels) {
      this.#pollChannel(channel, incidents, manualResult, nowMs);
    }
    if (incidents) {
      // After the new events are queued, so a newer reminder supersedes a held one.
      this.#releaseHeld();
      this.#visible = new Set(incidents.map((i) => i.id));
      this.#pruneLedger(nowMs);
    }
    if (hasAlerts) {
      this.#runAlerts({ checks: checksResult?.states, components }, nowMs);
      this.#pruneAlerts(nowMs);
    }
    return isOk;
  }

  /** The value of a feed read, or `undefined` after logging (once per kind) and counting its failure. */
  #feedValue<T>(feed: FeedName, read: PromiseSettledResult<T>): T | undefined {
    if (read.status === "fulfilled") {
      this.#opts.metrics?.feedPollDone(feed, "ok");
      if (this.#feedFailures.delete(feed)) this.#opts.logger.info("api feed recovered", { feed });
      return read.value;
    }
    this.#opts.metrics?.feedPollDone(feed, "error");
    const kind = read.reason instanceof ApiReadError ? read.reason.kind : "unknown";
    const logged = this.#feedFailures.get(feed) ?? new Set<string>();
    this.#feedFailures.set(feed, logged);
    if (!logged.has(kind)) {
      logged.add(kind);
      this.#opts.logger.error("api poll failed", { feed, ...errorFields(read.reason) });
    }
    return undefined;
  }

  /** Removes old settled entries at the first poll and then once per hour. */
  #pruneLedger(nowMs: number): void {
    if (this.#lastPruneMs !== undefined && nowMs - this.#lastPruneMs < PRUNE_EVERY_MS) return;
    this.#lastPruneMs = nowMs;
    const days = this.#opts.stateRetentionDays ?? 30;
    let count: number;
    try {
      count = this.#opts.ledger.prune(days * DAY_MS, this.#visible, this.#visibleManual);
    } catch (err) {
      this.#opts.logger.error("ledger prune failed, the next prune retries", errorFields(err));
      return;
    }
    if (count > 0) this.#opts.logger.info("old ledger entries pruned", { count });
  }

  /** One evaluation of all warning kinds, committed in one transaction, then enqueued. */
  #runAlerts(inputs: AlertInputs, nowMs: number): void {
    const { ledger, logger } = this.#opts;
    if (inputs.checks) this.#alertPresence.checks = new Set(inputs.checks.map((c) => c.id));
    if (inputs.components) {
      this.#alertPresence.components = new Set(inputs.components.map((c) => c.id));
    }
    let added: AlertDelivery[];
    try {
      const plan = planAlerts(this.#opts.config.channels, inputs, {
        lookup: (kind, id) => ledger.alertState(kind, id),
        hasChannel: (id) => ledger.hasChannel(id),
        threshold: this.#opts.budgetThreshold ?? 25,
        nowMs,
      });
      added = ledger.applyAlerts(plan.changes, plan.deliveries);
    } catch (err) {
      logger.error("alert state write failed, the next poll retries", errorFields(err));
      return;
    }
    for (const { channelId, key, notification } of added) {
      const channel = this.#channels.find((c) => c.config.id === channelId);
      if (!channel) continue;
      channel.queued.add(key);
      channel.delivery.enqueue(notification);
    }
  }

  /** Hourly, like the entry prune; a kind is pruned only after a good read of its feed. */
  #pruneAlerts(nowMs: number): void {
    if (this.#lastAlertPruneMs !== undefined && nowMs - this.#lastAlertPruneMs < PRUNE_EVERY_MS) {
      return;
    }
    this.#lastAlertPruneMs = nowMs;
    const days = this.#opts.stateRetentionDays ?? 30;
    let count: number;
    try {
      count = this.#opts.ledger.pruneAlerts(days * DAY_MS, this.#alertPresence);
    } catch (err) {
      this.#opts.logger.error("ledger prune failed, the next prune retries", errorFields(err));
      return;
    }
    if (count > 0) this.#opts.logger.info("old alert state pruned", { count });
  }

  #releaseHeld(): void {
    for (const channel of this.#channels) {
      const held = channel.held.splice(0);
      for (const { notification, recipients } of held) {
        channel.queued.add(notification.key);
        channel.delivery.enqueue(notification, recipients);
      }
    }
  }

  #reportVersionAbsent(): void {
    if (this.#isVersionAbsentReported) return;
    this.#isVersionAbsentReported = true;
    this.#opts.logger.warn("api sent no wire version header; continuing");
  }

  /** Counted on every poll; logged once per index. */
  #reportInvalidCheck(index: number): void {
    this.#opts.metrics?.itemSkipped("checks");
    if (!this.#malformed.add(`checks:index:${index}`)) return;
    this.#opts.logger.warn("check skipped: malformed data", {
      feed: "checks",
      index,
      reason: "invalid",
    });
  }

  /** Counted on every poll; logged once per index. */
  #reportInvalidComponent(index: number): void {
    this.#opts.metrics?.itemSkipped("components");
    if (!this.#malformed.add(`components:index:${index}`)) return;
    this.#opts.logger.warn("component skipped: malformed data", {
      feed: "components",
      index,
      reason: "invalid",
    });
  }

  /** Counted on every poll; logged once per identity. Only fixed texts and safe integers are logged. */
  #reportRejected(feed: "incidents" | "manual-incidents", rejected: RejectedIncident[]): void {
    for (const { index, id, reason } of rejected) {
      this.#opts.metrics?.itemSkipped(feed);
      const identity = id === undefined ? `${feed}:index:${index}` : `${feed}:id:${id}`;
      if (!this.#malformed.add(identity)) continue;
      this.#opts.logger.error("incident skipped: malformed data", {
        feed,
        index,
        reason,
        ...(id === undefined ? {} : { incidentId: id }),
      });
    }
  }

  /**
   * `undefined` means the feed failed this poll: its detection is skipped. A 404 on manual
   * incidents runs no manual detection and sets no manual mark. A new channel is
   * seeded only when both incident feeds answered, so a recovered feed sends no burst.
   */
  #pollChannel(
    channel: ChannelState,
    incidents: Incident[] | undefined,
    manual: ManualIncidentsResult | undefined,
    nowMs: number,
  ): void {
    const remindSeconds = channel.config.remindEverySeconds;
    const reminders: ReminderPlan | undefined =
      remindSeconds === undefined ? undefined : { everyMs: remindSeconds * 1000, nowMs };
    if (!this.#opts.ledger.hasChannel(channel.config.id)) {
      if (incidents && manual) this.#seedChannel(channel, incidents, manual, reminders, nowMs);
      return;
    }
    if (incidents && this.#syncCheckRouting(channel, incidents, reminders)) {
      if (!this.#syncReminderMark(channel.config.id, incidents, reminders, nowMs)) return;
      if (channel.config.sendIncidents !== false) {
        this.#rebuildLegacyPending(channel, incidents, nowMs);
      }
      this.#detectAutomatic(channel, incidents, reminders, nowMs);
    }
    // After automatic detection, so a failed manual seed does not hold back automatic events.
    if (manual && !manual.isAbsent) this.#pollManual(channel, manual.incidents, nowMs);
  }

  /** The first good manual read of a channel without `manualFrom` seeds its manual keys quietly. */
  #pollManual(channel: ChannelState, manual: ManualIncident[], nowMs: number): void {
    const { ledger, logger } = this.#opts;
    const id = channel.config.id;
    if (ledger.manualFrom(id) !== undefined) {
      if (this.#syncComponentRouting(channel, manual)) this.#detectManual(channel, manual);
      return;
    }
    const routed = manual.filter((i) => isManualRouted(channel.config, i.componentIds));
    try {
      ledger.seed(id, seedManualKeys(routed), {
        manualFrom: nowMs,
        componentRouting: componentRouting(channel.config),
      });
    } catch (err) {
      logger.error("ledger seed failed, the next poll retries", {
        channel: id,
        ...errorFields(err),
      });
      return;
    }
    logger.info("manual incidents initialized: existing manual incidents skipped", {
      channel: id,
      incidents: routed.length,
    });
  }

  #seedChannel(
    channel: ChannelState,
    incidents: Incident[],
    manual: ManualIncidentsResult,
    reminders: ReminderPlan | undefined,
    nowMs: number,
  ): void {
    const { ledger, logger } = this.#opts;
    const id = channel.config.id;
    try {
      ledger.seed(
        id,
        [
          ...seedKeys(incidents, reminders),
          ...seedManualKeys(
            manual.incidents.filter((i) => isManualRouted(channel.config, i.componentIds)),
          ),
        ],
        {
          ...(reminders ? { remindersFrom: nowMs } : {}),
          checkRouting: checkRouting(channel.config),
          // On a 404 the manual feed was not seen: its first good read seeds again.
          ...(manual.isAbsent
            ? {}
            : { manualFrom: nowMs, componentRouting: componentRouting(channel.config) }),
        },
      );
    } catch (err) {
      logger.error("ledger seed failed, the next poll retries", {
        channel: id,
        ...errorFields(err),
      });
      return;
    }
    logger.info("channel seeded with existing incidents", {
      channel: id,
      incidents: incidents.length,
    });
  }

  #detectAutomatic(
    channel: ChannelState,
    incidents: Incident[],
    reminders: ReminderPlan | undefined,
    nowMs: number,
  ): void {
    const { ledger } = this.#opts;
    const id = channel.config.id;
    const relevant = incidents.filter((i) => isRouted(channel.config, i.checkId));
    const events = detectEvents(
      relevant,
      (key) => ledger.has(id, key) || channel.queued.has(key),
      reminders,
    );
    if (channel.config.sendIncidents === false) {
      this.#seedIncidentKeys(
        id,
        events.map((e) => e.key),
      );
      return;
    }
    for (const { key, event, incident } of events) {
      this.#enqueue(channel, key, () =>
        buildNotification(...buildArgs(key, event, incident, this.#checkNames, nowMs)),
      );
    }
  }

  #detectManual(channel: ChannelState, manual: ManualIncident[]): void {
    const { ledger } = this.#opts;
    const id = channel.config.id;
    const isHandled = (key: string): boolean => ledger.has(id, key) || channel.queued.has(key);
    const relevantManual = manual.filter((i) => isManualRouted(channel.config, i.componentIds));
    const detectedEvents = detectManualEvents(relevantManual, isHandled);
    if (channel.config.sendIncidents === false) {
      this.#seedIncidentKeys(
        id,
        detectedEvents.map((d) => d.key),
      );
      return;
    }
    for (const detected of detectedEvents) {
      this.#enqueue(channel, detected.key, () => buildManualNotification(detected));
    }
  }

  /** A warning-only channel records the incident keys it would send as handled. */
  #seedIncidentKeys(channelId: string, keys: string[]): void {
    if (keys.length === 0) return;
    try {
      this.#opts.ledger.seed(channelId, keys);
    } catch (err) {
      this.#opts.logger.error("incident seed failed, the next poll retries", {
        channel: channelId,
        ...errorFields(err),
      });
    }
  }

  /**
   * Check filters changed since the stored baseline: the history of newly routed checks is
   * seeded, so widening a filter sends no burst. False if the ledger could not be written.
   */
  #syncCheckRouting(
    channel: ChannelState,
    incidents: Incident[],
    reminders: ReminderPlan | undefined,
  ): boolean {
    const { config } = channel;
    const stored = this.#opts.ledger.checkRouting(config.id);
    const old = stored === undefined ? undefined : parseCheckRouting(stored);
    const newly =
      old === undefined
        ? []
        : incidents.filter((i) => isRouted(config, i.checkId) && !isRouted(old, i.checkId));
    return this.#writeRouting(channel, stored, {
      current: checkRouting(config),
      mark: "checkRouting",
      keys: () => seedKeys(newly, reminders),
      count: newly.length,
      message: "routing changed: history of newly routed checks skipped",
    });
  }

  /** Like `#syncCheckRouting`, for the component filters of manual incidents. */
  #syncComponentRouting(channel: ChannelState, manual: ManualIncident[]): boolean {
    const { config } = channel;
    const stored = this.#opts.ledger.componentRouting(config.id);
    const old = stored === undefined ? undefined : parseComponentRouting(stored);
    const newly =
      old === undefined
        ? []
        : manual.filter(
            (i) => isManualRouted(config, i.componentIds) && !isManualRouted(old, i.componentIds),
          );
    return this.#writeRouting(channel, stored, {
      current: componentRouting(config),
      mark: "componentRouting",
      keys: () => seedManualKeys(newly),
      count: newly.length,
      message: "routing changed: history of newly routed manual incidents skipped",
    });
  }

  /**
   * Equal fingerprints write nothing. A missing one (an older ledger) becomes the baseline
   * without seeding; a changed one seeds `keys` with the new baseline in one transaction.
   */
  #writeRouting(
    channel: ChannelState,
    stored: string | undefined,
    change: {
      current: string;
      mark: "checkRouting" | "componentRouting";
      keys: () => string[];
      count: number;
      message: string;
    },
  ): boolean {
    const { ledger, logger } = this.#opts;
    const id = channel.config.id;
    if (stored === change.current) return true;
    try {
      ledger.seed(id, stored === undefined ? [] : change.keys(), { [change.mark]: change.current });
    } catch (err) {
      logger.error("ledger seed failed, the next poll retries", {
        channel: id,
        ...errorFields(err),
      });
      return false;
    }
    if (stored !== undefined) logger.info(change.message, { channel: id, incidents: change.count });
    return true;
  }

  /**
   * Reminders switched on for a channel that has none yet: the due reminder of every open
   * incident counts as handled, so enabling them does not send a burst. Switched off: the mark
   * goes, so enabling them again seeds again. False if the ledger could not be written.
   */
  #syncReminderMark(
    id: string,
    incidents: Incident[],
    reminders: ReminderPlan | undefined,
    nowMs: number,
  ): boolean {
    const { ledger, logger } = this.#opts;
    if (!reminders) {
      try {
        ledger.setRemindersFrom(id, undefined);
      } catch (err) {
        logger.error("ledger seed failed, the next poll retries", {
          channel: id,
          ...errorFields(err),
        });
        return false;
      }
      return true;
    }
    if (ledger.remindersFrom(id) !== undefined) return true;
    try {
      ledger.seed(
        id,
        seedKeys(incidents, reminders).filter((key) => REMINDER_KEY.test(key)),
        { remindersFrom: nowMs },
      );
    } catch (err) {
      logger.error("ledger seed failed, the next poll retries", {
        channel: id,
        ...errorFields(err),
      });
      return false;
    }
    logger.info("reminders enabled: due reminders of open incidents skipped", {
      channel: id,
    });
    return true;
  }

  /** Pending keys from an older version have no stored notification: rebuild it from the API. */
  #rebuildLegacyPending(channel: ChannelState, incidents: Incident[], nowMs: number): void {
    const id = channel.config.id;
    for (const { channelId, key, notification } of this.#opts.ledger.pending()) {
      if (channelId !== id || notification || channel.queued.has(key)) continue;
      const found = this.#findEvent(key, incidents);
      if (!found) {
        const reportKey = `${id}:${key}`;
        if (this.#legacyReported.has(reportKey)) continue;
        this.#legacyReported.add(reportKey);
        this.#opts.logger.error("pending notification cannot be rebuilt: incident not found", {
          channel: id,
          key,
        });
        continue;
      }
      this.#enqueue(channel, key, () =>
        buildNotification(...buildArgs(key, found.event, found.incident, this.#checkNames, nowMs)),
      );
    }
  }

  /**
   * Builds first, so a build error leaves the key unqueued and the next poll tries again.
   * Only the build is caught: errors from `enqueue` must surface.
   */
  #enqueue(channel: ChannelState, key: string, build: () => Notification): void {
    let notification: Notification;
    try {
      notification = build();
    } catch (err) {
      this.#opts.logger.error("notification cannot be built, the next poll retries", {
        channel: channel.config.id,
        key,
        ...errorFields(err),
      });
      return;
    }
    channel.queued.add(key);
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
