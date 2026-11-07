import type { MailMessage, SendMail, SmtpOptions } from "./channels/mailer.ts";
import { retryDelay } from "./delivery.ts";
import { PermanentDeliveryError } from "./errors.ts";
import type { MailboxGuard } from "./mailbox-guard.ts";
import { confirmationMessage } from "./subscriber-mail.ts";
import type { SubscriptionRow } from "./subscriber-store.ts";

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
    return this.#queue.length;
  }

  /** Queues a job; false when the queue is full or the worker stops. */
  enqueue(input: ConfirmationJobInput): boolean {
    if (this.#isStopping || this.#queue.length >= CONFIRMATION_QUEUE_MAX) return false;
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
    while (!this.#isStopping) {
      const attempt = this.#selectStep();
      if (attempt === undefined) await this.#waitRound();
      else await attempt;
    }
  }

  /** One synchronous selection step: drops stale jobs and starts the first ready one. */
  #selectStep(): Promise<void> | undefined {
    this.#selections += 1;
    const now = this.#deps.now();
    this.#hasReadFailed = false;
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
