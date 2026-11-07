import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ManualIncident, ManualIncidentUpdate } from "@lorenzh/pulse-contract";
import { PermanentDeliveryError } from "../src/errors.ts";
import { Ledger } from "../src/ledger.ts";
import { createMailboxGuard } from "../src/mailbox-guard.ts";
import { Notifier } from "../src/notifier.ts";
import { SubscriberStore, startCleanup } from "../src/subscriber-store.ts";
import {
  confirmTokenOf,
  countRows,
  fakeMailer,
  fakeScheduler,
  incidentHarness,
  insertConfirmed,
  letLoopRun,
  manualClock,
  orphanDeliveries,
  readStore,
  recordingSleep,
  type SubscriptionFixture,
  subscriptionFixture,
  TEST_KEY,
  tempDir,
  testUnsubscribeToken,
} from "./subscriptions-support.ts";
import { manualIncident, spyLogger, startFakeApi } from "./support.ts";

const A = "sub-a@example.com";
const B = "sub-b@example.com";
const C = "sub-c@example.com";

let fx: SubscriptionFixture | undefined;
afterEach(async () => {
  if (fx !== undefined) {
    // Map hygiene: every guard entry is released once the workers stopped.
    fx.guard.stop();
    await fx.incidents.stop();
    await fx.worker.stop();
    expect(fx.guard.size()).toBe(0);
    // The orphan invariant of D21 holds after every case of this file.
    expect(orphanDeliveries(fx.path)).toBe(0);
    await fx.close();
  }
  fx = undefined;
});

const rowOf = (f: SubscriptionFixture, email: string): { id: string; digest: string } =>
  readStore(f.path, (db) => {
    const r = db
      .query<{ id: string; confirm_digest: string }, [string]>(
        "SELECT id, confirm_digest FROM subscriptions WHERE email = ?",
      )
      .get(email);
    return { id: r?.id ?? "", digest: r?.confirm_digest ?? "" };
  });

const callsTo = (f: SubscriptionFixture, to: string): number =>
  f.mailer.calls.filter((c) => c.to === to).length;

/** A at t=0 (held by the fake), B at t=1, C at t=2. */
async function blockedFixture(opts: { timeoutMs?: number } = {}): Promise<SubscriptionFixture> {
  const f = subscriptionFixture(opts);
  fx = f;
  for (const [t, email] of [
    [0, A],
    [1, B],
    [2, C],
  ] as const) {
    f.clock.t = t;
    expect(f.ops.subscribe(email, t)).toBe("queued");
  }
  await letLoopRun();
  expect(f.mailer.calls.map((c) => c.to)).toEqual([A]);
  expect(f.worker.size()).toBe(3);
  return f;
}

describe("Confirmation queue (D19), behind a blocked send", () => {
  test("unsubscribe B removes its job at once; only C sends next", async () => {
    const f = await blockedFixture();
    f.clock.t = 10;
    expect(f.ops.unsubscribe(testUnsubscribeToken(rowOf(f, B).id, TEST_KEY))).toBe("ok");
    expect(f.worker.size()).toBe(2);
    expect(f.mailer.calls).toHaveLength(1);
    f.mailer.calls[0]?.resolve();
    await letLoopRun();
    expect(f.mailer.calls.map((c) => c.to)).toEqual([A, C]);
    f.mailer.calls[1]?.resolve();
    await letLoopRun();
    expect(f.outcomes).toEqual(["success", "success"]);
    expect(callsTo(f, B)).toBe(0);
  });

  test("cleanup at 90000000 drops B and C at once while A stays blocked", async () => {
    const f = await blockedFixture();
    const timers = fakeScheduler(f.clock);
    const cleanup = startCleanup({
      store: f.store,
      now: f.clock.now,
      retentionMs: 30 * 86_400_000,
      listedIds: () => undefined,
      onDeleted: (ids) => {
        for (const id of ids) f.worker.cancel(id);
      },
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      logError: () => {},
    });
    timers.advanceTo(90_000_000);
    expect(f.worker.size()).toBe(1);
    expect(f.mailer.calls).toHaveLength(1);
    f.mailer.calls[0]?.resolve();
    await letLoopRun();
    expect(f.worker.size()).toBe(0);
    expect(f.mailer.calls).toHaveLength(1);
    cleanup.stop();
  });

  test("rotating B keeps the gauge at 3 and sends only the current digest", async () => {
    const f = await blockedFixture();
    const before = rowOf(f, B).digest;
    f.clock.t = 600_001;
    expect(f.ops.subscribe(B, 600_001)).toBe("queued");
    expect(f.worker.size()).toBe(3);
    const after = rowOf(f, B).digest;
    expect(after).not.toBe(before);
    for (let i = 0; i < 3; i += 1) {
      f.mailer.calls[i]?.resolve();
      await letLoopRun();
    }
    const toB = f.mailer.calls.filter((c) => c.to === B);
    expect(toB).toHaveLength(1);
    const token = toB[0] === undefined ? "" : confirmTokenOf(toB[0]);
    expect(createHash("sha256").update(token).digest("hex")).toBe(after);
  });

  test("at exact expiry 86400001 B is dropped while C sends", async () => {
    const f = await blockedFixture();
    f.clock.t = 86_400_001;
    f.mailer.calls[0]?.resolve();
    await letLoopRun();
    expect(f.mailer.calls.map((c) => c.to)).toEqual([A, C]);
    expect(f.worker.size()).toBe(1);
  });

  test("a job in its retry wait does not block B, and cancelling it gives no second attempt", async () => {
    const f = await blockedFixture();
    f.clock.t = 3;
    f.mailer.calls[0]?.reject(new Error("temporary"));
    await letLoopRun();
    expect(f.mailer.calls.map((c) => c.to)).toEqual([A, B]);
    expect(f.clock.t).toBe(3);
    f.clock.t = 10;
    expect(f.ops.unsubscribe(testUnsubscribeToken(rowOf(f, A).id, TEST_KEY))).toBe("ok");
    expect(f.worker.size()).toBe(2);
    f.clock.t = 2000;
    f.mailer.calls[1]?.resolve();
    await letLoopRun();
    expect(f.mailer.calls.map((c) => c.to)).toEqual([A, B, C]);
    f.sleep.resolveAll();
    await letLoopRun();
    expect(callsTo(f, A)).toBe(1);
  });

  test("an unsubscribe does not abort the attempt in flight, which gets no retry", async () => {
    const f = await blockedFixture();
    expect(f.ops.unsubscribe(testUnsubscribeToken(rowOf(f, A).id, TEST_KEY))).toBe("ok");
    expect(f.mailer.calls[0]?.smtp.signal?.aborted).toBe(false);
    f.mailer.calls[0]?.reject(new Error("temporary"));
    await letLoopRun();
    f.clock.t = 100_000;
    f.sleep.resolveAll();
    await letLoopRun();
    expect(callsTo(f, A)).toBe(1);
    expect(f.outcomes[0]).toBe("failure");
  });

  test("timeouts given to the mailer: 60000 when capped, 5000 by default", async () => {
    const capped = await blockedFixture({ timeoutMs: 60_000 });
    expect(capped.mailer.calls[0]?.smtp.timeoutMs).toBe(60_000);
    for (const call of capped.mailer.calls) call.resolve();
    await letLoopRun();
    await capped.close();
    const plain = await blockedFixture();
    expect(plain.mailer.calls[0]?.smtp.timeoutMs).toBe(5000);
  });
});

describe("worker 1", () => {
  test("confirm cancels the queued and retrying job; counted in neither counter", async () => {
    const f = subscriptionFixture();
    fx = f;
    f.ops.subscribe(A, 0);
    await letLoopRun();
    const token = f.mailer.calls[0] === undefined ? "" : confirmTokenOf(f.mailer.calls[0]);
    f.mailer.calls[0]?.reject(new Error("temporary"));
    await letLoopRun();
    expect(f.worker.size()).toBe(1);
    expect(f.ops.confirm(token, 5)).toBe("ok");
    expect(f.worker.size()).toBe(0);
    f.clock.t = 5000;
    f.sleep.resolveAll();
    await letLoopRun();
    expect(f.mailer.calls).toHaveLength(1);
    expect(f.outcomes).toEqual([]);
  });

  test("a job makes at most 3 attempts, then one failure", async () => {
    const f = subscriptionFixture();
    fx = f;
    f.ops.subscribe(A, 0);
    for (const t of [1, 2000, 5000]) {
      await letLoopRun();
      f.clock.t = t;
      f.mailer.calls.at(-1)?.reject(new Error("temporary"));
      await letLoopRun();
      f.clock.t = t + 4000;
      f.sleep.resolveAll();
    }
    await letLoopRun();
    expect(f.mailer.calls).toHaveLength(3);
    expect(f.outcomes).toEqual(["failure"]);
    expect(f.worker.size()).toBe(0);
  });

  test("a permanent error ends the job at once", async () => {
    const f = subscriptionFixture();
    fx = f;
    f.ops.subscribe(A, 0);
    await letLoopRun();
    f.mailer.calls[0]?.reject(new PermanentDeliveryError("550", { status: 550 }));
    await letLoopRun();
    expect(f.outcomes).toEqual(["failure"]);
    expect(f.worker.size()).toBe(0);
  });

  test("stop drops waiting jobs and aborts the attempt in flight", async () => {
    const f = await blockedFixture();
    f.guard.stop();
    expect(await f.worker.stop()).toBe(2);
    expect(f.mailer.calls[0]?.smtp.signal?.aborted).toBe(true);
    expect(f.worker.size()).toBe(0);
    expect(f.guard.size()).toBe(0);
    expect(f.sleep.pending()).toBe(0);
  });

  test("the queue holds at most 100 jobs", async () => {
    const f = subscriptionFixture({ confirmPerHour: 1000 });
    fx = f;
    for (let i = 0; i < 101; i += 1) f.ops.subscribe(`u${i}@example.com`, i);
    expect(f.worker.size()).toBe(100);
    expect(f.limited).toEqual(["queue"]);
  });
});

describe("confirmation message", () => {
  test("one To address, origin links, literal hours, subject and Message-ID", async () => {
    const f = subscriptionFixture();
    fx = f;
    f.ops.subscribe(A, 0);
    await letLoopRun();
    const call = f.mailer.calls[0];
    const { id, digest } = rowOf(f, A);
    const token = call === undefined ? "" : confirmTokenOf(call);
    expect(call?.message.to).toEqual([A]);
    expect(call?.message.envelopeTo).toEqual([A]);
    expect(call?.message.from).toBe("Pulse <pulse@example.org>");
    expect(call?.message.subject).toBe("[status.example.com] Confirm your subscription");
    const mid = createHash("sha256").update(`confirm:${id}:1`).digest("hex").slice(0, 32);
    expect(call?.message.messageId).toBe(`<${mid}@example.org>`);
    expect(call?.message.text).toBe(
      [
        "Someone asked to get incident updates of https://status.example.com at this address.",
        "",
        `Confirm: https://status.example.com/subscribe/confirm?token=${token}`,
        "The link works for 24 hours. If you did not ask for this, ignore this email.",
        "If you do not confirm, your address is deleted within 25 hours.",
        "",
        `Unsubscribe: https://status.example.com/unsubscribe?token=${testUnsubscribeToken(id, TEST_KEY)}`,
        "About your data: https://status.example.com/#subscribe-notice",
        "",
      ].join("\n"),
    );
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Only the digest is stored, never the token itself.
    expect(createHash("sha256").update(token).digest("hex")).toBe(digest);
    expect(
      readStore(f.path, (db) => JSON.stringify(db.query("SELECT * FROM subscriptions").all())),
    ).not.toContain(token);
  });
});

describe("Expired jobs hold no queue capacity (R5 Subscribe step 1, selection)", () => {
  const expiredAt = 86_400_001;
  test.each([
    {
      name: "replacing an expired row at a full queue",
      jobs: 100,
      again: "sub-0@example.com",
      size: 1,
    },
    {
      name: "a fresh address beside an expired retrying job",
      jobs: 1,
      again: "fresh@example.com",
      size: 1,
    },
    {
      name: "a fresh address at a full queue of expired jobs",
      jobs: 100,
      again: "fresh@example.com",
      size: 1,
    },
  ])("$name: queued, gauge $size", async ({ jobs, again, size }) => {
    const f = subscriptionFixture({
      confirmPerHour: 1000,
      retryDelayMs: 90_000_000,
      retryMaxDelayMs: 90_000_000,
    });
    fx = f;
    for (let i = 0; i < jobs; i += 1) {
      expect(f.ops.subscribe(`sub-${i}@example.com`, 0)).toBe("queued");
    }
    for (let i = 0; i < jobs; i += 1) {
      await letLoopRun();
      f.mailer.calls[i]?.reject(new Error("try later"));
    }
    await letLoopRun();
    expect(f.worker.size()).toBe(jobs);
    f.clock.t = expiredAt;
    expect(f.ops.subscribe(again, expiredAt)).toBe("queued");
    await letLoopRun();
    expect(f.limited).toEqual([]);
    expect(f.worker.size()).toBe(size);
  });
});

// Worker 2: detection, fan-out, completion write and pass budget.

const ID_A = "a".repeat(22);
const ID_B = "b".repeat(22);
const PREFIX = "[status.example.com]";
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

const update = (at: number, status: ManualIncidentUpdate["status"], message: string) => ({
  at,
  status,
  message,
});
const inc = (id: number, over: Partial<ManualIncident> = {}): ManualIncident =>
  manualIncident({ id, title: `Incident ${id}`, ...over });

/** One good, non-404 manual read handed to the detection hook at `t`. */
function read(f: SubscriptionFixture, incidents: ManualIncident[], t: number): void {
  f.clock.t = t;
  f.detection.onManualRead({
    incidents,
    listedIds: new Set(incidents.map((i) => i.id)),
    nowMs: t,
  });
}

const isConfirmation = (subject: string): boolean => subject.endsWith("Confirm your subscription");
const incidentSubjects = (f: SubscriptionFixture, to: string): string[] =>
  f.mailer.calls
    .filter((c) => c.to === to && !isConfirmation(c.message.subject))
    .map((c) => c.message.subject);
const eventOf = (path: string, key: string): { status: string; passes: number; next: unknown } =>
  readStore(path, (db) => {
    const r = db
      .query<{ status: string; passes: number; next_pass_at: number | null }, [string]>(
        "SELECT status, passes, next_pass_at FROM events WHERE key = ?",
      )
      .get(key);
    return { status: r?.status ?? "none", passes: r?.passes ?? -1, next: r?.next_pass_at };
  });
const deliveriesOf = (path: string, id: string): number =>
  countRows(path, "SELECT count(*) AS n FROM deliveries WHERE subscription_id = ?", id);
const deliveryOf = (path: string, id: string): { status: string; attempts: number } =>
  readStore(path, (db) => {
    const r = db
      .query<{ status: string; attempts: number }, [string]>(
        "SELECT status, attempts FROM deliveries WHERE subscription_id = ?",
      )
      .get(id);
    return { status: r?.status ?? "none", attempts: r?.attempts ?? -1 };
  });
const E1 = "manual:1:opened";

describe("issue acceptance tests", () => {
  test("pending gets 0 incident mails; confirmed gets opened, update and resolved", async () => {
    const f = subscriptionFixture();
    fx = f;
    f.mailer.auto = "success";
    expect(f.ops.subscribe("pending@example.com", 0)).toBe("queued");
    insertConfirmed(f.store, { id: ID_A, email: A, confirmedAt: 0 });
    read(f, [], 0);
    const opened = inc(1, { createdAt: 100, updates: [update(100, "investigating", "Looking.")] });
    read(f, [opened], 100);
    await letLoopRun();
    const updated = {
      ...opened,
      updates: [...opened.updates, update(200, "identified", "Found.")],
    };
    read(f, [updated], 200);
    await letLoopRun();
    const resolved = {
      ...updated,
      status: "resolved" as const,
      resolvedAt: 300,
      updates: [...updated.updates, update(300, "resolved", "Fixed.")],
    };
    read(f, [resolved], 300);
    await letLoopRun();
    expect(incidentSubjects(f, A)).toEqual([
      "[status.example.com] New incident: Incident 1",
      "[status.example.com] Update: Incident 1",
      "[status.example.com] Resolved: Incident 1",
    ]);
    expect(incidentSubjects(f, "pending@example.com")).toEqual([]);
    expect(f.mailer.calls.filter((c) => c.to === "pending@example.com")).toHaveLength(1);
    expect(f.store.pendingEventCount()).toBe(0);
  });

  test("after unsubscribe 0 sends for a new incident; another confirmed gets 1", async () => {
    const f = subscriptionFixture();
    fx = f;
    f.mailer.auto = "success";
    insertConfirmed(f.store, { id: ID_A, email: A, confirmedAt: 0 });
    insertConfirmed(f.store, { id: ID_B, email: B, confirmedAt: 0 });
    read(f, [], 0);
    expect(f.ops.unsubscribe(testUnsubscribeToken(ID_A, TEST_KEY))).toBe("ok");
    read(f, [inc(1)], 10);
    await letLoopRun();
    expect(incidentSubjects(f, A)).toEqual([]);
    expect(incidentSubjects(f, B)).toEqual(["[status.example.com] New incident: Incident 1"]);
  });
});

describe("detection through the notifier and the api's public feed", () => {
  test("draft, draft update, note and internal give 0 sends; publishing gives 1 per confirmed row", async () => {
    const f = subscriptionFixture();
    fx = f;
    f.mailer.auto = "success";
    insertConfirmed(f.store, { id: ID_A, email: A, confirmedAt: 0 });
    insertConfirmed(f.store, { id: ID_B, email: B, confirmedAt: 0 });
    const api = await startFakeApi();
    const dir = tempDir("notify-detect-");
    const ledger = new Ledger(`${dir.dir}/state.json`, { now: f.clock.now });
    const notifier = new Notifier({
      config: { channels: [{ id: "out", type: "file", path: `${dir.dir}/out.jsonl` }] },
      apiUrl: api.url,
      ledger,
      logger: spyLogger(),
      now: f.clock.now,
      sleep: async () => {},
      schedule: () => () => {},
      onManualRead: f.detection.onManualRead,
    });
    const poll = async (t: number): Promise<void> => {
      f.clock.t = t;
      await notifier.tick();
      await notifier.idle();
      await letLoopRun();
    };
    try {
      api.manualIncidents = [];
      await poll(0);
      expect(f.detections.n).toBe(1);
      // Drafts, draft updates and notes live only in the api's private data; an older api
      // that leaks an internal incident is filtered by `isPublicManualIncident`.
      const leaked = { ...inc(5), visibility: "internal" };
      api.manualIncidents = [leaked];
      await poll(10);
      expect(f.detections.n).toBe(2);
      expect(countRows(f.path, "SELECT count(*) AS n FROM events")).toBe(0);
      api.failingManual = true;
      await poll(20);
      api.failingManual = false;
      api.manualIncidents = undefined;
      await poll(30);
      expect(f.detections.n).toBe(2);
      api.manualIncidents = [inc(6)];
      await poll(40);
      expect(f.detections.n).toBe(3);
      expect(incidentSubjects(f, A)).toEqual([`${PREFIX} New incident: Incident 6`]);
      expect(incidentSubjects(f, B)).toEqual([`${PREFIX} New incident: Incident 6`]);
      // Subscriber mail never enters the operator ledger or channel output.
      expect(readFileSync(`${dir.dir}/out.jsonl`, "utf8")).not.toContain(A);
    } finally {
      await notifier.stop();
      ledger.close();
      await api.close();
      dir.remove();
    }
  });
});

describe("Eligibility and privacy", () => {
  test("confirmed at 1000: an event detected at 999 is not sent, one at 1000 is", async () => {
    const f = subscriptionFixture();
    fx = f;
    f.mailer.auto = "success";
    read(f, [], 0);
    insertConfirmed(f.store, { id: ID_A, email: A, confirmedAt: 1000 });
    read(f, [inc(1)], 999);
    await letLoopRun();
    read(f, [inc(1), inc(2)], 1000);
    await letLoopRun();
    expect(incidentSubjects(f, A)).toEqual(["[status.example.com] New incident: Incident 2"]);
  });

  test("published at 500, confirmed at 1000, update at 2000: only the update", async () => {
    const f = subscriptionFixture();
    fx = f;
    f.mailer.auto = "success";
    read(f, [], 0);
    const one = inc(1);
    read(f, [one], 500);
    await letLoopRun();
    insertConfirmed(f.store, { id: ID_A, email: A, confirmedAt: 1000 });
    read(
      f,
      [{ ...one, updates: [...one.updates, update(T0 + 1, "monitoring", "Watching.")] }],
      2000,
    );
    await letLoopRun();
    expect(incidentSubjects(f, A)).toEqual(["[status.example.com] Update: Incident 1"]);
  });

  test("first enablement seeds 3 visible incidents with 0 sends; a later update sends once", async () => {
    const f = subscriptionFixture();
    fx = f;
    f.mailer.auto = "success";
    insertConfirmed(f.store, { id: ID_A, email: A, confirmedAt: 0 });
    insertConfirmed(f.store, { id: ID_B, email: B, confirmedAt: 0 });
    const three = [inc(1), inc(2), inc(3)];
    read(f, three, 10);
    await letLoopRun();
    expect(f.mailer.calls).toHaveLength(0);
    expect(countRows(f.path, "SELECT count(*) AS n FROM events WHERE status = 'seeded'")).toBe(3);
    const later = three.map((i) =>
      i.id === 2 ? { ...i, updates: [...i.updates, update(T0 + 5, "identified", "Found.")] } : i,
    );
    read(f, later, 20);
    await letLoopRun();
    expect(incidentSubjects(f, A)).toEqual(["[status.example.com] Update: Incident 2"]);
    expect(incidentSubjects(f, B)).toEqual(["[status.example.com] Update: Incident 2"]);
  });

  test("a temporarily private incident that is public again sends nothing twice", async () => {
    const f = subscriptionFixture();
    fx = f;
    f.mailer.auto = "success";
    insertConfirmed(f.store, { id: ID_A, email: A, confirmedAt: 0 });
    read(f, [], 0);
    read(f, [inc(1)], 10);
    await letLoopRun();
    read(f, [], 20);
    read(f, [inc(1)], 30);
    await letLoopRun();
    expect(incidentSubjects(f, A)).toHaveLength(1);
  });

  test("each message has one To, no other subscriber, a stable Message-ID and origin links", async () => {
    const f = subscriptionFixture();
    fx = f;
    f.mailer.auto = "success";
    insertConfirmed(f.store, { id: ID_A, email: A, confirmedAt: 0 });
    insertConfirmed(f.store, { id: ID_B, email: B, confirmedAt: 0 });
    read(f, [], 0);
    read(f, [inc(1)], 10);
    await letLoopRun();
    const toA = f.mailer.calls.find((c) => c.to === A);
    expect(toA?.message.to).toEqual([A]);
    expect(toA?.message.envelopeTo).toEqual([A]);
    expect(toA?.message.text).not.toContain(B);
    expect(toA?.message.subject).toBe(`${PREFIX} New incident: Incident 1`);
    const digest = createHash("sha256").update(`${E1}:${ID_A}`).digest("hex").slice(0, 32);
    expect(toA?.message.messageId).toBe(`<${digest}@example.org>`);
    expect(toA?.message.text).toBe(
      [
        "New incident: Incident 1",
        "",
        "Impact: minor",
        "Status: investigating",
        "We are looking.",
        "Time: 2026-01-01T12:00:00.000Z",
        "",
        "Status page: https://status.example.com",
        "You get this email because you subscribed at https://status.example.com.",
        `Unsubscribe: https://status.example.com/unsubscribe?token=${testUnsubscribeToken(ID_A, TEST_KEY)}`,
        "",
      ].join("\n"),
    );
  });

  test("the detection counter grows only after the rows are readable", () => {
    const f = subscriptionFixture();
    fx = f;
    const seen: number[] = [];
    const harness = incidentHarness({
      store: f.store,
      guard: f.guard,
      clock: f.clock,
      mailer: f.mailer,
      sleep: f.sleep,
      retryAttempts: 3,
    });
    read(f, [], 0);
    const detection = { ...harness.detection };
    // A second connection counts the pending rows at the moment the counter grows.
    const store = f.store;
    const hook = (incidents: ManualIncident[], t: number): void => {
      const before = harness.detections.n;
      detection.onManualRead({ incidents, listedIds: new Set(), nowMs: t });
      if (harness.detections.n > before) {
        seen.push(countRows(f.path, "SELECT count(*) AS n FROM events WHERE status = 'pending'"));
      }
    };
    hook([inc(1), inc(2)], 10);
    hook([inc(1), inc(2)], 20);
    store.close();
    hook([inc(3)], 30);
    expect(seen).toEqual([2, 2]);
    expect(harness.detections.n).toBe(2);
  });
});

describe("Late completion after delete (D21)", () => {
  /** A and B confirmed, B already has E1; E1 and E2 detected; A's E1 send held, A unsubscribed. */
  async function lateFixture(): Promise<SubscriptionFixture> {
    const f = subscriptionFixture();
    fx = f;
    insertConfirmed(f.store, { id: ID_A, email: A, confirmedAt: 0 });
    insertConfirmed(f.store, { id: ID_B, email: B, confirmedAt: 0 });
    read(f, [], 0);
    const db = new Database(f.path);
    db.query(
      "INSERT INTO deliveries (event_key, subscription_id, status, attempts, at) VALUES (?, ?, 'sent', 1, 0)",
    ).run(E1, ID_B);
    db.close();
    read(f, [inc(1), inc(2)], 10);
    await letLoopRun();
    expect(f.mailer.calls.map((c) => c.to)).toEqual([A]);
    f.clock.t = 20;
    expect(f.ops.unsubscribe(testUnsubscribeToken(ID_A, TEST_KEY))).toBe("ok");
    return f;
  }

  test.each([
    { name: "success", settle: "success", outcome: "success" },
    { name: "permanent 550", settle: "permanent", outcome: "failure" },
    { name: "temporary failure", settle: "temporary", outcome: "failure" },
    { name: "timeout", settle: "timeout", outcome: "failure" },
  ])("late $name writes nothing for the deleted row", async ({ settle, outcome }) => {
    const f = await lateFixture();
    f.mailer.auto = "success";
    const call = f.mailer.calls[0];
    if (settle === "success") call?.resolve();
    else if (settle === "permanent")
      call?.reject(new PermanentDeliveryError("550", { status: 550 }));
    else if (settle === "temporary") call?.reject(new Error("421 try later"));
    else call?.reject(new Error("smtp attempt timed out after 5000 ms"));
    await letLoopRun();
    expect(countRows(f.path, "SELECT count(*) AS n FROM subscriptions WHERE id = ?", ID_A)).toBe(0);
    expect(deliveriesOf(f.path, ID_A)).toBe(0);
    expect(f.incidentOutcomes[0]).toBe(outcome);
    expect(eventOf(f.path, E1)).toEqual({ status: "done", passes: 1, next: null });
    expect(f.sleep.record).toEqual([]);
    expect(f.mailer.calls.map((c) => c.to)).toEqual([A, B]);
    expect(f.mailer.calls[1]?.message.subject).toBe(`${PREFIX} New incident: Incident 2`);
    expect(f.store.pendingEventCount()).toBe(0);
    expect(f.guard.size()).toBe(0);
  });

  test("a re-subscribed address gets a new pending row, 0 deliveries, confirmation after settle", async () => {
    const f = await lateFixture();
    f.clock.t = 30;
    expect(f.ops.subscribe(A, 30)).toBe("queued");
    await letLoopRun();
    const a2 = rowOf(f, A).id;
    expect(a2).not.toBe(ID_A);
    expect(f.mailer.calls.map((c) => c.to)).toEqual([A]);
    f.mailer.auto = "success";
    f.mailer.calls[0]?.resolve();
    await letLoopRun();
    expect(deliveriesOf(f.path, ID_A)).toBe(0);
    expect(deliveriesOf(f.path, a2)).toBe(0);
    expect(f.store.subscriptionById(a2)?.state).toBe("pending");
    const toA = f.mailer.calls.filter((c) => c.to === A).map((c) => c.message.subject);
    expect(toA).toEqual([
      `${PREFIX} New incident: Incident 1`,
      `${PREFIX} Confirm your subscription`,
    ]);
    expect(f.mailer.order.indexOf(`settle:${A}`)).toBeLessThan(
      f.mailer.order.lastIndexOf(`start:${A}`),
    );
    expect(f.mailer.maxInFlight.get(A)).toBe(1);
  });

  test("erasure: the store and WAL bytes hold neither the old address nor its id", async () => {
    const f = await lateFixture();
    f.mailer.auto = "success";
    f.mailer.calls[0]?.resolve();
    await letLoopRun();
    expect(eventOf(f.path, E1).status).toBe("done");
    f.store.checkpoint();
    for (const file of [f.path, `${f.path}-wal`]) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(file);
      } catch {
        continue; // A missing -wal file holds nothing.
      }
      expect(bytes.includes(Buffer.from(A))).toBe(false);
      expect(bytes.includes(Buffer.from(ID_A))).toBe(false);
    }
  });

  test("worker 1: a late confirmation settle writes nothing (data_version unchanged)", async () => {
    const f = subscriptionFixture();
    fx = f;
    expect(f.ops.subscribe(C, 0)).toBe("queued");
    await letLoopRun();
    const { id } = rowOf(f, C);
    const second = new Database(f.path, { readonly: true });
    const version = (): number =>
      second.query<{ data_version: number }, []>("PRAGMA data_version").get()?.data_version ?? -1;
    try {
      expect(f.ops.unsubscribe(testUnsubscribeToken(id, TEST_KEY))).toBe("ok");
      const after = version();
      f.mailer.calls[0]?.resolve();
      await letLoopRun();
      expect(version()).toBe(after);
      expect(countRows(f.path, "SELECT count(*) AS n FROM subscriptions WHERE id = ?", id)).toBe(0);
    } finally {
      second.close();
    }
  });
});

describe("Fan-out failures", () => {
  test("550 for row 1: failed after 1 attempt, row 2 still gets the message", async () => {
    const f = subscriptionFixture();
    fx = f;
    insertConfirmed(f.store, { id: ID_A, email: A, confirmedAt: 0 });
    insertConfirmed(f.store, { id: ID_B, email: B, confirmedAt: 0 });
    read(f, [], 0);
    read(f, [inc(1)], 10);
    await letLoopRun();
    f.mailer.auto = "success";
    f.mailer.calls[0]?.reject(new PermanentDeliveryError("550", { status: 550 }));
    await letLoopRun();
    expect(deliveryOf(f.path, ID_A)).toEqual({ status: "failed", attempts: 1 });
    expect(deliveryOf(f.path, ID_B)).toEqual({ status: "sent", attempts: 1 });
    expect(f.incidentOutcomes).toEqual(["failure", "success"]);
    expect(eventOf(f.path, E1).status).toBe("done");
  });

  test("a temporary error, then an unsubscribe before pass 2: 0 more sends to row 1", async () => {
    const f = subscriptionFixture();
    fx = f;
    insertConfirmed(f.store, { id: ID_A, email: A, confirmedAt: 0 });
    insertConfirmed(f.store, { id: ID_B, email: B, confirmedAt: 0 });
    read(f, [], 0);
    read(f, [inc(1)], 10);
    await letLoopRun();
    f.mailer.auto = "success";
    f.mailer.calls[0]?.reject(new Error("421 later"));
    await letLoopRun();
    expect(f.sleep.record).toEqual([1000]);
    expect(f.ops.unsubscribe(testUnsubscribeToken(ID_A, TEST_KEY))).toBe("ok");
    f.clock.t = 1010;
    f.sleep.resolveAll();
    await letLoopRun();
    expect(f.mailer.calls.map((c) => c.to)).toEqual([A, B]);
    expect(eventOf(f.path, E1)).toEqual({ status: "done", passes: 2, next: 1010 });
  });

  test("RETRY_ATTEMPTS=0: row 1 always failing is failed after 12 passes, then E2 starts", async () => {
    const f = subscriptionFixture({ retryAttempts: 0 });
    fx = f;
    insertConfirmed(f.store, { id: ID_A, email: A, confirmedAt: 0 });
    read(f, [], 0);
    f.mailer.auto = "temporary";
    read(f, [inc(1), inc(2)], 10);
    for (let i = 0; i < 14; i += 1) {
      await letLoopRun();
      f.clock.t += 100_000;
      f.sleep.resolveAll();
    }
    await letLoopRun();
    expect(incidentSubjects(f, A).filter((s) => s.endsWith("Incident 1"))).toHaveLength(12);
    expect(deliveryOf(f.path, ID_A)).toEqual({ status: "failed", attempts: 12 });
    expect(eventOf(f.path, E1).status).toBe("done");
    expect(incidentSubjects(f, A).some((s) => s.endsWith("Incident 2"))).toBe(true);
  });

  test("250 rows: 3 id pages, one send each; row 2 unsubscribed while row 1 is held gets none", async () => {
    const f = subscriptionFixture();
    fx = f;
    const ids = Array.from({ length: 250 }, (_, i) => `r${String(i).padStart(21, "0")}`);
    for (const [i, id] of ids.entries()) {
      insertConfirmed(f.store, { id, email: `row-${i}@example.com`, confirmedAt: 0 });
    }
    const pages: string[] = [];
    const eligibleIds = f.store.eligibleIds.bind(f.store);
    f.store.eligibleIds = (key, after, limit) => {
      if (limit === undefined) pages.push(after ?? "");
      return eligibleIds(key, after, limit);
    };
    read(f, [], 0);
    read(f, [inc(1)], 10);
    await letLoopRun();
    expect(f.mailer.calls).toHaveLength(1);
    expect(f.ops.unsubscribe(testUnsubscribeToken(ids[1] ?? "", TEST_KEY))).toBe("ok");
    f.mailer.auto = "success";
    f.mailer.calls[0]?.resolve();
    await letLoopRun(400);
    const sent = f.mailer.calls.map((c) => c.to);
    expect(sent).toHaveLength(249);
    expect(new Set(sent).size).toBe(249);
    expect(sent).not.toContain("row-1@example.com");
    expect(pages).toHaveLength(3);
    expect(eventOf(f.path, E1).status).toBe("done");
  });

  test("stop aborts the send in flight and keeps the event pending without a delivery row", async () => {
    const f = subscriptionFixture();
    fx = f;
    insertConfirmed(f.store, { id: ID_A, email: A, confirmedAt: 0 });
    read(f, [], 0);
    read(f, [inc(1)], 10);
    await letLoopRun();
    f.guard.stop();
    await f.incidents.stop();
    expect(f.mailer.calls[0]?.isSettled).toBe(true);
    expect(eventOf(f.path, E1)).toEqual({ status: "pending", passes: 1, next: null });
    expect(deliveriesOf(f.path, ID_A)).toBe(0);
    expect(f.incidentOutcomes).toEqual([]);
    expect(f.guard.size()).toBe(0);
  });
});

describe("Pass budget across restarts (new worker and store on the same file)", () => {
  /** A store file with row 1 confirmed and E1, E2 pending at `t`; the parts survive restarts. */
  function budgetFile(retryAttempts = 3) {
    const tmp = tempDir("notify-budget-");
    const path = `${tmp.dir}/subs.db`;
    const clock = manualClock(0);
    const mailer = fakeMailer();
    const sleep = recordingSleep();
    let store = SubscriberStore.open(path);
    insertConfirmed(store, { id: ID_A, email: A, confirmedAt: 0 });
    let harness = incidentHarness({
      store,
      guard: createMailboxGuard(),
      clock,
      mailer,
      sleep,
      retryAttempts,
    });
    harness.detection.onManualRead({ incidents: [], listedIds: new Set(), nowMs: 0 });
    harness.detection.onManualRead({
      incidents: [inc(1), inc(2)],
      listedIds: new Set([1, 2]),
      nowMs: 0,
    });
    const parts = {
      path,
      clock,
      mailer,
      sleep,
      e1Calls: () => mailer.calls.filter((c) => c.message.subject.endsWith("Incident 1")).length,
      start: () => {
        store = SubscriberStore.open(path);
        harness = incidentHarness({
          store,
          guard: createMailboxGuard(),
          clock,
          mailer,
          sleep,
          retryAttempts,
        });
        harness.worker.start();
      },
      stop: async () => {
        await harness.worker.stop();
        store.close();
      },
      remove: () => tmp.remove(),
    };
    store.close();
    return parts;
  }

  test("stop in the sleep before pass 3, restart: 3 attempts in total, then E2", async () => {
    const b = budgetFile();
    b.mailer.auto = "temporary";
    b.start();
    await letLoopRun();
    b.clock.t = 1000;
    b.sleep.resolveAll();
    await letLoopRun();
    expect(b.e1Calls()).toBe(2);
    expect(b.sleep.pending()).toBe(1);
    await b.stop();
    expect(eventOf(b.path, E1).passes).toBe(2);
    b.clock.t = 3000;
    b.start();
    await letLoopRun();
    expect(b.e1Calls()).toBe(3);
    expect(deliveryOf(b.path, ID_A)).toEqual({ status: "failed", attempts: 3 });
    expect(eventOf(b.path, E1).status).toBe("done");
    expect(b.mailer.calls.at(-1)?.message.subject).toBe(`${PREFIX} New incident: Incident 2`);
    await b.stop();
    b.remove();
  });

  test("stop inside committed pass 3: restart sends 0 more for E1 and E2 starts before any sleep", async () => {
    const b = budgetFile();
    b.mailer.auto = "temporary";
    b.start();
    await letLoopRun();
    b.clock.t = 1000;
    b.sleep.resolveAll();
    await letLoopRun();
    b.mailer.auto = undefined;
    b.clock.t = 3000;
    b.sleep.resolveAll();
    await letLoopRun();
    expect(b.e1Calls()).toBe(3);
    expect(eventOf(b.path, E1).passes).toBe(3);
    await b.stop();
    const sleeps = b.sleep.record.length;
    b.start();
    await letLoopRun();
    expect(b.e1Calls()).toBe(3);
    expect(deliveryOf(b.path, ID_A)).toEqual({ status: "failed", attempts: 3 });
    expect(eventOf(b.path, E1).status).toBe("done");
    expect(b.mailer.calls.at(-1)?.message.subject).toBe(`${PREFIX} New incident: Incident 2`);
    expect(b.sleep.record).toHaveLength(sleeps);
    await b.stop();
    b.remove();
  });

  test("restart at T+100 waits the remaining 300 ms, not 1000", async () => {
    const b = budgetFile();
    b.mailer.auto = "temporary";
    b.clock.t = 400;
    b.start();
    await letLoopRun();
    expect(eventOf(b.path, E1).next).toBe(1400);
    b.clock.t = 1000;
    await b.stop();
    b.clock.t = 1100;
    b.start();
    await letLoopRun();
    expect(b.sleep.record).toEqual([1000, 300]);
    await b.stop();
    b.remove();
  });

  test("ten restarts never start more than 3 passes for E1", async () => {
    const b = budgetFile();
    b.mailer.auto = "temporary";
    for (let i = 0; i < 10; i += 1) {
      b.clock.t += 100_000;
      b.start();
      await letLoopRun();
      await b.stop();
    }
    expect(b.e1Calls()).toBe(3);
    expect(eventOf(b.path, E1)).toMatchObject({ status: "done", passes: 3 });
    b.remove();
  });

  test("a restart after an event is done sends nothing for it", async () => {
    const b = budgetFile();
    b.mailer.auto = "success";
    b.start();
    await letLoopRun();
    await b.stop();
    expect(b.mailer.calls).toHaveLength(2);
    b.start();
    await letLoopRun();
    expect(b.mailer.calls).toHaveLength(2);
    await b.stop();
    b.remove();
  });
});
