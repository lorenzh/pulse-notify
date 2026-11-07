import type { ManualIncident } from "@lorenzh/pulse-contract";
import type { MailMessage, SendMail, SmtpOptions } from "./channels/mailer.ts";
import { retryDelay } from "./delivery.ts";
import { type DetectedManualEvent, detectManualEvents } from "./detector.ts";
import { PermanentDeliveryError } from "./errors.ts";
import type { MailboxGuard } from "./mailbox-guard.ts";
import {
  confirmationMessage,
  type IncidentPayload,
  incidentMessage,
  unsubscribeToken,
} from "./subscriber-mail.ts";
import {
  ELIGIBLE_PAGE_SIZE,
  type EventRow,
  type SubscriberStore,
  type SubscriptionRow,
} from "./subscriber-store.ts";

/** The confirmation queue holds at most this many jobs, in flight included (L6). */
export const CONFIRMATION_QUEUE_MAX = 100;
/** Attempts per confirmation job. */
export const CONFIRMATION_ATTEMPTS = 3;

export type MailOutcome = "success" | "failure";

/** What a confirmation job needs; the queue is the only place in notify that holds its address. */
export interface ConfirmationJobInput {
  id: string;
  /** The `confirm_digest` the job was queued for. */
  digest: string;
  expiresAt: number;
  address: string;
  confirmToken: string;
  unsubscribeToken: string;
  confirmSends: number;
}

interface Job extends ConfirmationJobInput {
  key: string;
  attempts: number;
  notBefore: number;
  isInFlight: boolean;
  isCancelled: boolean;
}

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export interface ConfirmationWorkerDeps {
  /** Reads a row by id; the store's `subscriptionById`. */
  readRow: (id: string) => SubscriptionRow | undefined;
  guard: MailboxGuard;
  sendMail: SendMail;
  /** SMTP settings of every attempt, without the per-attempt timeout and signal. */
  smtp: Omit<SmtpOptions, "timeoutMs" | "signal">;
  /** `min(PULSE_NOTIFY_TIMEOUT_MS, 60000)` (D12). */
  timeoutMs: number;
  mail: { from: string; subjectPrefix: string; statusUrl: string };
  now: () => number;
  sleep: Sleep;
  retryDelayMs: number;
  retryMaxDelayMs: number;
  /** A final outcome: `pulse_notify_subscriber_mails_total{kind="confirmation"}`. */
  onOutcome?: (outcome: MailOutcome) => void;
  logError?: (message: string, fields?: Record<string, unknown>) => void;
}

function isStale(job: Job, row: SubscriptionRow | undefined, now: number): boolean {
  return (
    now >= job.expiresAt ||
    row === undefined ||
    row.state !== "pending" ||
    row.confirmDigest !== job.digest
  );
}

function isPermanent(err: unknown): boolean {
  return err instanceof PermanentDeliveryError;
}

/**
 * Worker 1 (R5 "Confirmation mail"): an in-memory queue of at most 100 jobs, one attempt at a
 * time, up to 3 attempts per job. A job waiting for its retry or for a busy mailbox never holds
 * back a ready job of another mailbox. Between rounds it sleeps only until a future `notBefore`
 * and otherwise waits for a held mailbox to settle, a new job, a cancel or stop.
 */
export class ConfirmationWorker {
  readonly #deps: ConfirmationWorkerDeps;
  #queue: Job[] = [];
  #selections = 0;
  #isStopping = false;
  #wake: () => void = () => {};
  #round: AbortController | undefined;
  #attempt: AbortController | undefined;
  #loop: Promise<void> | undefined;
  #hasReadFailed = false;

  constructor(deps: ConfirmationWorkerDeps) {
    this.#deps = deps;
  }

  /** Selection steps run so far (tests only; not a metric). */
  get selections(): number {
    return this.#selections;
  }

  /** Jobs queued or in flight: `pulse_notify_subscriber_confirmations_queued`. */
  size(): number {
    this.#dropExpired(this.#deps.now());
    return this.#queue.length;
  }

  /** Queues a job; false when the queue is full or the worker stops. */
  enqueue(input: ConfirmationJobInput): boolean {
    if (this.#isStopping || this.size() >= CONFIRMATION_QUEUE_MAX) return false;
    this.#queue.push({
      ...input,
      key: this.#deps.guard.key(input.address),
      attempts: 0,
      notBefore: 0,
      isInFlight: false,
      isCancelled: false,
    });
    this.#wake();
    return true;
  }

  /**
   * Removes every job of row `id` that has no attempt in flight, at once (D19). An attempt in
   * flight is neither awaited nor aborted; its job makes no further attempt.
   */
  cancel(id: string): void {
    for (const job of this.#queue) if (job.id === id) job.isCancelled = true;
    this.#queue = this.#queue.filter((job) => job.id !== id || job.isInFlight);
    this.#wake();
  }

  start(): void {
    this.#loop ??= this.#run();
  }

  /** Stops selection, aborts the attempt in flight and drops the queue; the dropped count. */
  async stop(): Promise<number> {
    this.#isStopping = true;
    this.#attempt?.abort();
    this.#round?.abort();
    this.#wake();
    await this.#loop;
    const dropped = this.#queue.length;
    this.#queue = [];
    return dropped;
  }

  async #run(): Promise<void> {
    while (!this.#isStopping && !this.#deps.guard.isStopped()) {
      const attempt = this.#selectStep();
      if (attempt === undefined) await this.#waitRound();
      else await attempt;
    }
  }

  /** Expired jobs hold no queue capacity, whether or not their retry is due (R5). */
  #dropExpired(now: number): void {
    for (const job of [...this.#queue]) {
      if (!job.isInFlight && now >= job.expiresAt) this.#remove(job);
    }
  }

  /** One synchronous selection step: drops stale jobs and starts the first ready one. */
  #selectStep(): Promise<void> | undefined {
    this.#selections += 1;
    const now = this.#deps.now();
    this.#hasReadFailed = false;
    this.#dropExpired(now);
    for (const job of [...this.#queue]) {
      if (job.isInFlight || job.notBefore > now) continue;
      let row: SubscriptionRow | undefined;
      try {
        row = this.#deps.readRow(job.id);
      } catch (err) {
        this.#deps.logError?.("confirmation worker could not read the store", {
          error: err instanceof Error ? err.name : "unknown",
        });
        this.#hasReadFailed = true;
        return undefined;
      }
      if (isStale(job, row, now)) {
        this.#remove(job);
        continue;
      }
      const owner = this.#deps.guard.tryAcquire(job.key);
      if (owner !== undefined) return this.#startAttempt(job, owner, now);
    }
    return undefined;
  }

  #startAttempt(job: Job, owner: number, now: number): Promise<void> {
    job.isInFlight = true;
    job.attempts += 1;
    const controller = new AbortController();
    this.#attempt = controller;
    const message: MailMessage = confirmationMessage({
      ...this.#deps.mail,
      address: job.address,
      id: job.id,
      confirmSends: job.confirmSends,
      confirmToken: job.confirmToken,
      unsubscribeToken: job.unsubscribeToken,
      date: new Date(now),
    });
    const sending = this.#deps.sendMail(
      { ...this.#deps.smtp, timeoutMs: this.#deps.timeoutMs, signal: controller.signal },
      message,
    );
    return sending
      .then(
        (result) => this.#settle(job, result.accepted.length > 0 ? "success" : "failure"),
        (err: unknown) => this.#settleError(job, err),
      )
      .finally(() => {
        this.#attempt = undefined;
        this.#deps.guard.release(job.key, owner);
      });
  }

  #settleError(job: Job, err: unknown): void {
    const isFinal =
      isPermanent(err) ||
      job.attempts >= CONFIRMATION_ATTEMPTS ||
      job.isCancelled ||
      this.#isStopping;
    if (isFinal) {
      this.#settle(job, "failure");
      return;
    }
    job.isInFlight = false;
    job.notBefore =
      this.#deps.now() +
      retryDelay(job.attempts, this.#deps.retryDelayMs, this.#deps.retryMaxDelayMs);
  }

  #settle(job: Job, outcome: MailOutcome): void {
    this.#deps.onOutcome?.(outcome);
    this.#remove(job);
  }

  #remove(job: Job): void {
    this.#queue = this.#queue.filter((other) => other !== job);
  }

  /**
   * Waits for the first of: the earliest future `notBefore`, a held mailbox to settle, a new job
   * or cancel, or stop. Its sleep and waits are aborted before the next selection step.
   */
  async #waitRound(): Promise<void> {
    if (this.#isStopping) return;
    const woken = new Promise<void>((resolve) => {
      this.#wake = resolve;
    });
    const controller = new AbortController();
    this.#round = controller;
    const now = this.#deps.now();
    let earliest: number | undefined;
    const heldKeys = new Set<string>();
    for (const job of this.#queue) {
      if (job.isInFlight) continue;
      // After a failed store read every waiting job counts as timed, so the worker cannot spin.
      if (this.#hasReadFailed) earliest = now + Math.max(1, this.#deps.retryDelayMs);
      else if (job.notBefore > now) earliest = Math.min(earliest ?? job.notBefore, job.notBefore);
      else heldKeys.add(job.key);
    }
    const waits: Promise<void>[] = [woken];
    if (earliest !== undefined) {
      // Deliberately ignored: an aborted sleep only ends this round.
      waits.push(this.#deps.sleep(earliest - now, controller.signal).catch(() => {}));
    }
    for (const key of heldKeys) waits.push(this.#deps.guard.waitFor(key, controller.signal));
    await Promise.race(waits);
    controller.abort();
    this.#round = undefined;
    this.#wake = () => {};
  }
}

/** A notifier read of `/manual-incidents` that answered and was not a 404. */
export interface ManualRead {
  incidents: ManualIncident[];
  listedIds: ReadonlySet<number>;
  nowMs: number;
}

function incidentPayload(detected: DetectedManualEvent): IncidentPayload {
  const { incident, event, updateIndex, timeMs } = detected;
  const update = incident.updates[updateIndex];
  const message =
    event === "resolved" ? (incident.updates.at(-1)?.message ?? "") : (update?.message ?? "");
  return {
    event,
    title: incident.title,
    impact: incident.impact,
    status: event === "resolved" ? "resolved" : (update?.status ?? incident.status),
    message,
    time: new Date(timeMs).toISOString(),
  };
}

const PAYLOAD_EVENTS: readonly string[] = ["opened", "update", "resolved"];

/** The stored payload of an event, or `undefined` when the row does not hold one. */
export function parsePayload(text: string | null): IncidentPayload | undefined {
  if (text === null) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const fields = [v.title, v.impact, v.status, v.message, v.time];
  if (!PAYLOAD_EVENTS.includes(String(v.event))) return undefined;
  if (!fields.every((f) => typeof f === "string")) return undefined;
  return value as IncidentPayload;
}

export interface SubscriberDetectionDeps {
  store: SubscriberStore;
  /** Wakes worker 2 after new pending events committed. */
  wake: () => void;
  /** `pulse_notify_subscriber_detections_total`, after the transaction committed. */
  onDetected?: () => void;
  logError?: (message: string, fields?: Record<string, unknown>) => void;
}

/** R5 "Detection": the notifier hook for each good, non-404 manual read. */
export interface SubscriberDetection {
  onManualRead: (read: ManualRead) => void;
  /** Manual ids of the last good read; `undefined` before the first one (cleanup prunes nothing). */
  listedIds: () => ReadonlySet<number> | undefined;
}

export function createSubscriberDetection(deps: SubscriberDetectionDeps): SubscriberDetection {
  let listed: ReadonlySet<number> | undefined;
  return {
    listedIds: () => listed,
    onManualRead: (read) => {
      listed = read.listedIds;
      const { store } = deps;
      try {
        if (store.metaValue("manual_baseline_at") === undefined) {
          const seeded = detectManualEvents(read.incidents, () => false);
          store.seedEvents(
            seeded.map((e) => ({ key: e.key, manualId: e.incident.id })),
            read.nowMs,
          );
        } else {
          const found = detectManualEvents(read.incidents, (key) => store.hasEvent(key));
          store.addPendingEvents(
            found.map((e) => ({
              key: e.key,
              manualId: e.incident.id,
              payload: JSON.stringify(incidentPayload(e)),
            })),
            read.nowMs,
          );
        }
      } catch (err) {
        deps.logError?.("subscriber detection could not write the store", {
          error: err instanceof Error ? err.name : "unknown",
        });
        return;
      }
      deps.onDetected?.();
      deps.wake();
    },
  };
}

export interface IncidentWorkerDeps {
  store: SubscriberStore;
  guard: MailboxGuard;
  sendMail: SendMail;
  smtp: Omit<SmtpOptions, "timeoutMs" | "signal">;
  /** `min(PULSE_NOTIFY_TIMEOUT_MS, 60000)` (D12). */
  timeoutMs: number;
  mail: { from: string; subjectPrefix: string; statusUrl: string };
  /** The HMAC key (64 hex) of the unsubscribe links. */
  key: string;
  now: () => number;
  sleep: Sleep;
  /** `PULSE_NOTIFY_RETRY_ATTEMPTS`; `0` means 12 passes. */
  retryAttempts: number;
  retryDelayMs: number;
  retryMaxDelayMs: number;
  /** Each settled attempt: `pulse_notify_subscriber_mails_total{kind="incident"}`. */
  onOutcome?: (outcome: MailOutcome) => void;
  logError?: (message: string, fields?: Record<string, unknown>) => void;
}

/** Passes per event when `PULSE_NOTIFY_RETRY_ATTEMPTS` is 0, so one address never holds the queue. */
export const UNLIMITED_PASSES = 12;

type SendResult = "sent" | "failed" | "retry" | "stopped";

/**
 * Worker 2 (R5 "Fan-out"): one pending event at a time, ordered by `detected_at` and `key`. The
 * pass count and the next pass time are stored, so a restart never resets the pass budget.
 */
export class IncidentWorker {
  readonly #deps: IncidentWorkerDeps;
  #isStopping = false;
  #wake: () => void = () => {};
  #isWoken = false;
  readonly #stop = new AbortController();
  #loop: Promise<void> | undefined;

  constructor(deps: IncidentWorkerDeps) {
    this.#deps = deps;
  }

  get #passLimit(): number {
    return this.#deps.retryAttempts === 0 ? UNLIMITED_PASSES : this.#deps.retryAttempts;
  }

  start(): void {
    this.#loop ??= this.#run();
  }

  /** New pending events were committed. */
  wake(): void {
    this.#isWoken = true;
    this.#wake();
  }

  /** Aborts the sleep, the mailbox wait and the send in flight; the event stays `pending`. */
  async stop(): Promise<void> {
    this.#isStopping = true;
    this.#stop.abort();
    this.#wake();
    await this.#loop;
  }

  get #isOver(): boolean {
    return this.#isStopping || this.#deps.guard.isStopped();
  }

  async #run(): Promise<void> {
    while (!this.#isOver) {
      this.#isWoken = false;
      let next: EventRow | undefined;
      try {
        next = this.#deps.store.pendingEvents()[0];
        if (next !== undefined) await this.#runEvent(next.key);
      } catch (err) {
        this.#deps.logError?.("incident worker could not use the store", {
          error: err instanceof Error ? err.name : "unknown",
        });
        await this.#sleep(Math.max(1, this.#deps.retryDelayMs));
        continue;
      }
      if (next === undefined) await this.#waitWake();
    }
  }

  async #waitWake(): Promise<void> {
    if (this.#isWoken || this.#isOver) return;
    await new Promise<void>((resolve) => {
      this.#wake = resolve;
    });
    this.#wake = () => {};
  }

  async #sleep(ms: number): Promise<void> {
    // Deliberately ignored: an aborted sleep only means stop.
    await this.#deps.sleep(ms, this.#stop.signal).catch(() => {});
  }

  /** Steps 1-4 of R5 "Pass budget" for one event, until it is `done` or the worker stops. */
  async #runEvent(key: string): Promise<void> {
    const { store } = this.#deps;
    while (!this.#isOver) {
      const event = store.event(key);
      if (event?.status !== "pending") return;
      if (event.passes >= this.#passLimit) {
        store.finalizeEvent(key, this.#deps.now());
        return;
      }
      const now = this.#deps.now();
      if (event.nextPassAt !== null && now < event.nextPassAt) {
        await this.#sleep(event.nextPassAt - now);
        continue;
      }
      const passes = store.startPass(key);
      const payload = parsePayload(event.payload);
      if (payload === undefined) {
        // An event without a readable payload can never be sent; it must not hold the queue.
        this.#deps.logError?.("incident event has no readable payload; skipped");
        store.finalizeEvent(key, this.#deps.now());
        return;
      }
      await this.#runPass(event, payload, passes);
      if (this.#isOver) return;
      if (store.eligibleIds(key, "", 1).length === 0) {
        store.markDone(key, this.#deps.now());
        return;
      }
      const { retryDelayMs, retryMaxDelayMs } = this.#deps;
      store.setNextPassAt(
        key,
        this.#deps.now() + retryDelay(passes, retryDelayMs, retryMaxDelayMs),
      );
    }
  }

  /** One pass: every eligible id, in pages of 100 by id, one send at a time. */
  async #runPass(event: EventRow, payload: IncidentPayload, passes: number): Promise<void> {
    let after = "";
    for (;;) {
      const ids = this.#deps.store.eligibleIds(event.key, after);
      for (const id of ids) {
        if (this.#isOver) return;
        await this.#sendTo(event, payload, passes, id);
      }
      const last = ids.at(-1);
      if (last === undefined || ids.length < ELIGIBLE_PAGE_SIZE) return;
      after = last;
    }
  }

  /** Reads the row, takes the mailbox and starts the send in one synchronous step (D12, D20). */
  async #sendTo(
    event: EventRow,
    payload: IncidentPayload,
    passes: number,
    id: string,
  ): Promise<void> {
    const { store, guard } = this.#deps;
    while (!this.#isOver) {
      const row = store.subscriptionById(id);
      if (row?.state !== "confirmed") return;
      const key = guard.key(row.email);
      const owner = guard.tryAcquire(key);
      if (owner === undefined) {
        // Only the row id and the key are held while another send to this mailbox is open.
        await guard.waitFor(key, this.#stop.signal);
        continue;
      }
      const result = await this.#attempt(event, payload, row, key, owner);
      const status = result === "sent" || result === "failed" ? result : undefined;
      if (status !== undefined) {
        store.completeDelivery({
          eventKey: event.key,
          subscriptionId: id,
          status,
          attempts: passes,
          at: this.#deps.now(),
        });
      }
      return;
    }
  }

  async #attempt(
    event: EventRow,
    payload: IncidentPayload,
    row: SubscriptionRow,
    key: string,
    owner: number,
  ): Promise<SendResult> {
    const d = this.#deps;
    const message = incidentMessage({
      ...d.mail,
      address: row.email,
      id: row.id,
      eventKey: event.key,
      payload,
      unsubscribeToken: unsubscribeToken(row.id, d.key),
      date: new Date(d.now()),
    });
    try {
      const result = await d.sendMail(
        { ...d.smtp, timeoutMs: d.timeoutMs, signal: this.#stop.signal },
        message,
      );
      const isAccepted = result.accepted.length > 0;
      d.onOutcome?.(isAccepted ? "success" : "failure");
      return isAccepted ? "sent" : "failed";
    } catch (err) {
      if (this.#isStopping) return "stopped";
      d.onOutcome?.("failure");
      return isPermanent(err) ? "failed" : "retry";
    } finally {
      d.guard.release(key, owner);
    }
  }
}
