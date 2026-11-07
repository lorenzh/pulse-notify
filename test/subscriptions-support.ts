import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MailMessage, SendMail, SendMailResult, SmtpOptions } from "../src/channels/mailer.ts";
import type { LockDeps } from "../src/ledger-lock.ts";
import { createMailboxGuard, type MailboxGuard } from "../src/mailbox-guard.ts";
import {
  ConfirmationWorker,
  createSubscriberDetection,
  IncidentWorker,
  type SubscriberDetection,
} from "../src/subscriber-fanout.ts";
import { SubscriberStore } from "../src/subscriber-store.ts";
import {
  createSubscriptionOperations,
  type SubscriptionOperations,
} from "../src/subscription-requests.ts";

/** A fresh `mkdtemp` directory and its cleanup. */
export function tempDir(prefix: string): { dir: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A manual clock: tests move `t` by hand. */
export interface ManualClock {
  t: number;
  now: () => number;
}

export function manualClock(start = 0): ManualClock {
  const clock: ManualClock = { t: start, now: () => clock.t };
  return clock;
}

/** A fake scheduler: timers run only when the test calls `advanceTo`. */
export interface FakeScheduler {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  /** Moves the clock to `t`, running each due timer at its own time, in order. */
  advanceTo: (t: number) => void;
  pending: () => number;
}

export function fakeScheduler(clock: ManualClock): FakeScheduler {
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout: (fn, ms) => {
      seq += 1;
      timers.set(seq, { at: clock.t + ms, fn });
      return seq;
    },
    clearTimeout: (handle) => {
      if (typeof handle === "number") timers.delete(handle);
    },
    advanceTo: (t) => {
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | undefined;
        for (const entry of timers) {
          if (entry[1].at <= t && (next === undefined || entry[1].at < next[1].at)) next = entry;
        }
        if (next === undefined) break;
        timers.delete(next[0]);
        clock.t = next[1].at;
        next[1].fn();
      }
      clock.t = t;
    },
    pending: () => timers.size,
  };
}

/** Lock dependencies of a lone test process. */
export function testLockDeps(now: () => number = Date.now): LockDeps {
  let n = 0;
  return {
    now,
    hostname: () => "test-host",
    pid: process.pid,
    isPidAlive: () => true,
    leaseSeconds: 60,
    token: () => `token-${++n}`,
  };
}

/** A second connection to the store file, as another process would see it. */
export function readStore<T>(path: string, read: (db: Database) => T): T {
  const db = new Database(path, { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

export function countRows(path: string, sql: string, ...params: string[]): number {
  return readStore(path, (db) => {
    const row = db.query<{ n: number }, string[]>(sql).get(...params);
    return row?.n ?? -1;
  });
}

/** A recorded `sendMail` call; the test settles it by hand. */
export interface MailCall {
  to: string;
  smtp: SmtpOptions;
  message: MailMessage;
  resolve: () => void;
  reject: (err: Error) => void;
  isSettled: boolean;
}

/** A recording fake mailer with per-address in-flight counts and their largest values. */
export interface FakeMailer {
  sendMail: SendMail;
  calls: MailCall[];
  /** Start and settle order, as `start:<to>` and `settle:<to>`. */
  order: string[];
  maxInFlight: Map<string, number>;
  /** When set, a call settles at once (success, or a temporary `421` error) instead of being held. */
  auto?: "success" | "temporary" | undefined;
}

export function fakeMailer(): FakeMailer {
  const inFlight = new Map<string, number>();
  const mailer: FakeMailer = {
    calls: [],
    order: [],
    maxInFlight: new Map(),
    sendMail: (smtp, message) => {
      const to = message.envelopeTo.join(",");
      const count = (inFlight.get(to) ?? 0) + 1;
      inFlight.set(to, count);
      mailer.maxInFlight.set(to, Math.max(mailer.maxInFlight.get(to) ?? 0, count));
      mailer.order.push(`start:${to}`);
      return new Promise<SendMailResult>((resolve, reject) => {
        const settle = (): boolean => {
          if (call.isSettled) return false;
          call.isSettled = true;
          inFlight.set(to, (inFlight.get(to) ?? 1) - 1);
          mailer.order.push(`settle:${to}`);
          return true;
        };
        const call: MailCall = {
          to,
          smtp,
          message,
          isSettled: false,
          resolve: () => {
            if (settle()) resolve({ accepted: [to], refused: [] });
          },
          reject: (err) => {
            if (settle()) reject(err);
          },
        };
        mailer.calls.push(call);
        smtp.signal?.addEventListener("abort", () => call.reject(new Error("aborted")), {
          once: true,
        });
        if (mailer.auto === "success") call.resolve();
        else if (mailer.auto === "temporary") call.reject(new Error("421 try again later"));
      });
    },
  };
  return mailer;
}

/** A recording sleep: `ms <= 0` resolves at once; else it waits for the test or its signal. */
export interface RecordingSleep {
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  record: number[];
  pending: () => number;
  /** Resolves every pending sleep. */
  resolveAll: () => void;
}

export function recordingSleep(): RecordingSleep {
  const waiting = new Set<() => void>();
  const record: number[] = [];
  return {
    record,
    sleep: (ms, signal) => {
      record.push(ms);
      if (ms <= 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const done = (): void => {
          waiting.delete(done);
          resolve();
        };
        waiting.add(done);
        signal.addEventListener("abort", done, { once: true });
      });
    },
    pending: () => waiting.size,
    resolveAll: () => {
      for (const done of [...waiting]) done();
    },
  };
}

/** Lets the event loop run: `turns` rounds of `setImmediate`. */
export async function letLoopRun(turns = 100): Promise<void> {
  for (let i = 0; i < turns; i += 1) await new Promise((r) => setImmediate(r));
}

/** The test's own unsubscribe token: `<id>.<base64url HMAC-SHA256(key, "pulse-unsubscribe:<id>")>`. */
export function testUnsubscribeToken(id: string, keyHex: string): string {
  const mac = createHmac("sha256", Buffer.from(keyHex, "hex"))
    .update(`pulse-unsubscribe:${id}`)
    .digest("base64url");
  return `${id}.${mac}`;
}

export const TEST_KEY = "a".repeat(64);
export const TEST_BEARER = "t".repeat(40);

/** The confirmation token of a mail: the `token` of its confirm link. */
export function confirmTokenOf(call: MailCall): string {
  return /subscribe\/confirm\?token=([A-Za-z0-9_-]{43})/.exec(call.message.text)?.[1] ?? "";
}

export interface FixtureOptions {
  max?: number;
  maxPending?: number;
  confirmPerHour?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
  retryMaxDelayMs?: number;
  /** `PULSE_NOTIFY_RETRY_ATTEMPTS` of worker 2; default 3. */
  retryAttempts?: number;
  /** Replaces the shared guard, for the self-checks with a wrong guard. */
  guard?: MailboxGuard;
}

/** A store in its own temp dir, worker 1, the operations and fakes, wired as `main` will wire them. */
export interface SubscriptionFixture {
  path: string;
  store: SubscriberStore;
  clock: ManualClock;
  mailer: FakeMailer;
  sleep: RecordingSleep;
  guard: MailboxGuard;
  worker: ConfirmationWorker;
  ops: SubscriptionOperations;
  limited: string[];
  outcomes: string[];
  /** Worker 2 and the detection hook, sharing the guard, store, clock, mailer and sleep. */
  incidents: IncidentWorker;
  detection: SubscriberDetection;
  incidentOutcomes: string[];
  /** `pulse_notify_subscriber_detections_total`. */
  detections: { n: number };
  /** Stops the worker, closes the store and removes the directory. */
  close: () => Promise<void>;
}

export function subscriptionFixture(opts: FixtureOptions = {}): SubscriptionFixture {
  const tmp = tempDir("notify-subs-");
  const path = join(tmp.dir, "subs.db");
  const store = SubscriberStore.open(path);
  const clock = manualClock(0);
  const mailer = fakeMailer();
  const sleep = recordingSleep();
  const guard = opts.guard ?? createMailboxGuard();
  const outcomes: string[] = [];
  const limited: string[] = [];
  const worker = new ConfirmationWorker({
    readRow: (id) => store.subscriptionById(id),
    guard,
    sendMail: mailer.sendMail,
    smtp: { host: "127.0.0.1", port: 2525, tls: "none" },
    timeoutMs: opts.timeoutMs ?? 5000,
    mail: {
      from: "Pulse <pulse@example.org>",
      subjectPrefix: "[status.example.com]",
      statusUrl: "https://status.example.com",
    },
    now: clock.now,
    sleep: sleep.sleep,
    retryDelayMs: opts.retryDelayMs ?? 1000,
    retryMaxDelayMs: opts.retryMaxDelayMs ?? 60_000,
    onOutcome: (o) => outcomes.push(o),
  });
  const ops = createSubscriptionOperations({
    store,
    queue: worker,
    key: TEST_KEY,
    max: opts.max ?? 10_000,
    maxPending: opts.maxPending ?? 1000,
    confirmPerHour: opts.confirmPerHour ?? 100,
    onLimited: (l) => limited.push(l),
  });
  const harness = incidentHarness({
    store,
    guard,
    clock,
    mailer,
    sleep,
    timeoutMs: opts.timeoutMs ?? 5000,
    retryAttempts: opts.retryAttempts ?? 3,
    retryDelayMs: opts.retryDelayMs ?? 1000,
    retryMaxDelayMs: opts.retryMaxDelayMs ?? 60_000,
  });
  worker.start();
  harness.worker.start();
  let isClosed = false;
  return {
    path,
    store,
    clock,
    mailer,
    sleep,
    guard,
    worker,
    ops,
    limited,
    outcomes,
    incidents: harness.worker,
    detection: harness.detection,
    incidentOutcomes: harness.outcomes,
    detections: harness.detections,
    close: async () => {
      if (isClosed) return;
      isClosed = true;
      guard.stop();
      await harness.worker.stop();
      await worker.stop();
      try {
        store.close();
      } catch {
        // A test may have closed the store already.
      }
      tmp.remove();
    },
  };
}

export const TEST_MAIL = {
  from: "Pulse <pulse@example.org>",
  subjectPrefix: "[status.example.com]",
  statusUrl: "https://status.example.com",
} as const;

export interface IncidentHarnessInput {
  store: SubscriberStore;
  guard: MailboxGuard;
  clock: ManualClock;
  mailer: FakeMailer;
  sleep: RecordingSleep;
  timeoutMs?: number;
  retryAttempts: number;
  retryDelayMs?: number;
  retryMaxDelayMs?: number;
}

export interface IncidentHarness {
  worker: IncidentWorker;
  detection: SubscriberDetection;
  outcomes: string[];
  detections: { n: number };
}

/** Worker 2 and its detection hook over a store, wired as `main` will wire them (not started). */
export function incidentHarness(input: IncidentHarnessInput): IncidentHarness {
  const outcomes: string[] = [];
  const detections = { n: 0 };
  const worker = new IncidentWorker({
    store: input.store,
    guard: input.guard,
    sendMail: input.mailer.sendMail,
    smtp: { host: "127.0.0.1", port: 2525, tls: "none" },
    timeoutMs: input.timeoutMs ?? 5000,
    mail: TEST_MAIL,
    key: TEST_KEY,
    now: input.clock.now,
    sleep: input.sleep.sleep,
    retryAttempts: input.retryAttempts,
    retryDelayMs: input.retryDelayMs ?? 1000,
    retryMaxDelayMs: input.retryMaxDelayMs ?? 60_000,
    onOutcome: (o) => outcomes.push(o),
  });
  const detection = createSubscriberDetection({
    store: input.store,
    wake: () => worker.wake(),
    onDetected: () => {
      detections.n += 1;
    },
  });
  return { worker, detection, outcomes, detections };
}

/** A `confirmed` row with an id the test picks, written through the store. */
export function insertConfirmed(
  store: SubscriberStore,
  row: { id: string; email: string; confirmedAt: number },
): void {
  store.insertPending({
    id: row.id,
    email: row.email,
    now: row.confirmedAt,
    digest: `digest-${row.id}`,
    expiresAt: row.confirmedAt + 86_400_000,
  });
  store.confirm(row.id, row.confirmedAt);
}

/** The orphan invariant of D21: delivery rows without a subscription row. */
export function orphanDeliveries(path: string): number {
  return countRows(
    path,
    "SELECT count(*) AS n FROM deliveries d WHERE NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.id = d.subscription_id)",
  );
}
