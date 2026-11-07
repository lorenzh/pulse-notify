import { afterEach, describe, expect, test } from "bun:test";
import { normalizeSubscriberEmail } from "@lorenzh/pulse-contract";
import { PermanentDeliveryError } from "../src/errors.ts";
import { createMailboxGuard, type MailboxGuard } from "../src/mailbox-guard.ts";
import {
  confirmTokenOf,
  countRows,
  insertConfirmed,
  letLoopRun,
  orphanDeliveries,
  readStore,
  recordingSleep,
  type SubscriptionFixture,
  subscriptionFixture,
  TEST_KEY,
  testUnsubscribeToken,
} from "./subscriptions-support.ts";
import { manualIncident } from "./support.ts";

const M = "sub-m@example.com";
const N = "sub-n@example.com";

describe("mailbox guard (D20)", () => {
  test("owner check: a late release cannot free a newer owner", () => {
    const guard = createMailboxGuard();
    const k = guard.key(M);
    expect(guard.tryAcquire(k)).toBe(1);
    guard.release(k, 1);
    expect(guard.tryAcquire(k)).toBe(2);
    guard.release(k, 1);
    expect(guard.size()).toBe(1);
    expect(guard.tryAcquire(k)).toBeUndefined();
    guard.release(k, 2);
    expect(guard.size()).toBe(0);
    guard.stop();
    expect(guard.tryAcquire(guard.key(N))).toBeUndefined();
  });

  test("keys use a fresh salt per guard and never hold the address", () => {
    const one = createMailboxGuard();
    const two = createMailboxGuard();
    expect(normalizeSubscriberEmail(" SUB-M@Example.COM ")).toBe("sub-m@example.com");
    expect(one.key(M)).toMatch(/^[0-9a-f]{64}$/);
    expect(one.key(M)).toBe(one.key("sub-m@example.com"));
    expect(one.key(M)).not.toBe(two.key(M));
    expect(one.key(M)).not.toContain("sub-m");
  });

  test("waitFor resolves on settle, at once without an entry, and on abort", async () => {
    const guard = createMailboxGuard();
    const k = guard.key(M);
    await guard.waitFor(k);
    const owner = guard.tryAcquire(k) ?? 0;
    let isDone = false;
    const waiting = guard.waitFor(k).then(() => {
      isDone = true;
    });
    await letLoopRun(5);
    expect(isDone).toBe(false);
    guard.release(k, owner);
    await waiting;
    expect(isDone).toBe(true);
    guard.tryAcquire(k);
    const controller = new AbortController();
    const aborted = guard.waitFor(k, controller.signal);
    controller.abort();
    await aborted;
    expect(guard.size()).toBe(1);
  });
});

let fx: SubscriptionFixture | undefined;
afterEach(async () => {
  if (fx !== undefined) {
    // Map hygiene and the orphan invariant of D21 after every case.
    fx.guard.stop();
    await fx.incidents.stop();
    await fx.worker.stop();
    expect(fx.guard.size()).toBe(0);
    expect(orphanDeliveries(fx.path)).toBe(0);
    await fx.close();
  }
  fx = undefined;
});

describe("worker 1 with a held mailbox (R5 Wake rule)", () => {
  test("no elapsed wake, other mailboxes progress, the held job starts on settle", async () => {
    const f = subscriptionFixture({ retryDelayMs: 1000 });
    fx = f;
    // Stands in for worker 2: an incident send to M is in flight.
    const mKey = f.guard.key(M);
    const owner = f.guard.tryAcquire(mKey) ?? 0;
    const callsTo = (to: string): number => f.mailer.calls.filter((c) => c.to === to).length;

    // Step 1: M's job (notBefore 0) is held; no sleep, no selection growth.
    f.clock.t = 40;
    expect(f.ops.subscribe(M, 40)).toBe("queued");
    await letLoopRun();
    const s0 = f.worker.selections;
    await letLoopRun();
    expect(f.worker.selections - s0).toBe(0);
    expect(f.sleep.record).toEqual([]);
    expect(callsTo(M)).toBe(0);

    // Step 2: N progresses; its retry gives one sleep of 1000.
    f.clock.t = 41;
    expect(f.ops.subscribe(N, 41)).toBe("queued");
    await letLoopRun();
    expect(f.mailer.calls.map((c) => c.to)).toEqual([N]);
    f.clock.t = 42;
    f.mailer.calls[0]?.reject(new Error("temporary"));
    await letLoopRun();
    expect(f.sleep.record).toEqual([1000]);
    expect(f.sleep.pending()).toBe(1);
    const s1 = f.worker.selections;
    await letLoopRun();
    expect(f.worker.selections - s1).toBe(0);

    // Step 3: an early wake sleeps again for the rest.
    f.clock.t = 500;
    f.sleep.resolveAll();
    await letLoopRun();
    expect(f.sleep.record).toEqual([1000, 542]);
    expect(f.sleep.pending()).toBe(1);
    expect(callsTo(N)).toBe(1);
    expect(callsTo(M)).toBe(0);

    // Step 4: at the exact deadline N is ready; no sleep of 0.
    f.clock.t = 1042;
    f.sleep.resolveAll();
    await letLoopRun();
    expect(f.mailer.calls.map((c) => c.to)).toEqual([N, N]);
    expect(f.sleep.record).toEqual([1000, 542]);
    f.mailer.calls[1]?.resolve();
    await letLoopRun();

    // Step 5: the guard's settle starts M's job.
    f.clock.t = 1100;
    f.guard.release(mKey, owner);
    await letLoopRun();
    expect(f.mailer.calls.map((c) => c.to)).toEqual([N, N, M]);
    expect(f.sleep.record).toEqual([1000, 542]);
    expect(f.mailer.maxInFlight.get(M)).toBe(1);
    expect(f.sleep.record.every((ms) => ms >= 1)).toBe(true);
    f.mailer.calls[2]?.resolve();
    await letLoopRun();

    f.guard.stop();
    await f.worker.stop();
    expect(f.sleep.pending()).toBe(0);
    expect(f.guard.size()).toBe(0);
  });

  test("a deferred job keeps its place while another mailbox sends; at most 1 sleep pending", async () => {
    const f = subscriptionFixture();
    fx = f;
    const owner = f.guard.tryAcquire(f.guard.key(M)) ?? 0;
    f.ops.subscribe(M, 0);
    f.ops.subscribe(N, 1);
    await letLoopRun();
    expect(f.mailer.calls.map((c) => c.to)).toEqual([N]);
    expect(f.worker.size()).toBe(2);
    f.mailer.calls[0]?.resolve();
    await letLoopRun();
    expect(f.sleep.pending()).toBe(0);
    f.guard.release(f.guard.key(M), owner);
    await letLoopRun();
    expect(f.mailer.calls.map((c) => c.to)).toEqual([N, M]);
  });

  test("stop wakes a waiting worker and leaves no sleep pending", async () => {
    const f = subscriptionFixture();
    fx = f;
    f.ops.subscribe(N, 0);
    await letLoopRun();
    f.clock.t = 1;
    f.mailer.calls[0]?.reject(new Error("temporary"));
    await letLoopRun();
    expect(f.sleep.pending()).toBe(1);
    f.guard.stop();
    expect(await f.worker.stop()).toBe(1);
    expect(f.sleep.pending()).toBe(0);
  });
});

// Both real workers share one guard across subscription generations (D20).

const E1 = "manual:1:opened";
const CONFIRM_SUBJECT = "[status.example.com] Confirm your subscription";
const INCIDENT_SUBJECT = "[status.example.com] New incident: Search is slow";

const idOf = (f: SubscriptionFixture, email: string): string =>
  readStore(
    f.path,
    (db) =>
      db.query<{ id: string }, [string]>("SELECT id FROM subscriptions WHERE email = ?").get(email)
        ?.id ?? "",
  );
const callsTo = (f: SubscriptionFixture, to: string): number =>
  f.mailer.calls.filter((c) => c.to === to).length;
const seed = (f: SubscriptionFixture): void => {
  f.detection.onManualRead({ incidents: [], listedIds: new Set(), nowMs: 0 });
};
const detect = (f: SubscriptionFixture, t: number): void => {
  f.clock.t = t;
  f.detection.onManualRead({
    incidents: [manualIncident({ id: 1 })],
    listedIds: new Set([1]),
    nowMs: t,
  });
};
const deliveriesOf = (f: SubscriptionFixture, ...ids: string[]): number =>
  countRows(
    f.path,
    `SELECT count(*) AS n FROM deliveries WHERE subscription_id IN (${ids.map(() => "?").join(", ")})`,
    ...ids,
  );
/** The literal bound of D20: at most 1 send in flight per mailbox, as the mailer saw it. */
const expectBound = (f: SubscriptionFixture): void => {
  expect(f.mailer.maxInFlight.get(M) ?? 0).toBeLessThanOrEqual(1);
  expect(f.mailer.maxInFlight.get(N) ?? 0).toBeLessThanOrEqual(1);
};
const unsubscribe = (f: SubscriptionFixture, id: string, t: number): void => {
  f.clock.t = t;
  expect(f.ops.unsubscribe(testUnsubscribeToken(id, TEST_KEY))).toBe("ok");
};
const subscribe = (f: SubscriptionFixture, email: string, t: number): void => {
  f.clock.t = t;
  expect(f.ops.subscribe(email, t)).toBe("queued");
};

/** M1 confirmed at t=10, E1 detected at 20 with M1's incident send held, unsubscribed at 30. */
async function heldIncident(guard?: MailboxGuard): Promise<{ f: SubscriptionFixture; m1: string }> {
  const f = subscriptionFixture(guard === undefined ? {} : { guard });
  fx = f;
  seed(f);
  f.mailer.auto = "success";
  subscribe(f, M, 0);
  await letLoopRun();
  const m1 = idOf(f, M);
  f.clock.t = 10;
  expect(f.ops.confirm(confirmTokenOf(f.mailer.calls[0] ?? fail()), 10)).toBe("ok");
  f.mailer.auto = undefined;
  detect(f, 20);
  await letLoopRun();
  expect(f.mailer.calls.map((c) => c.message.subject)).toEqual([CONFIRM_SUBJECT, INCIDENT_SUBJECT]);
  unsubscribe(f, m1, 30);
  expectBound(f);
  return { f, m1 };
}

function fail(): never {
  throw new Error("missing mail call");
}

describe("One send per mailbox (D20), two workers and re-subscription", () => {
  test("normalized spellings share one key", () => {
    const guard = createMailboxGuard();
    const spelled = normalizeSubscriberEmail(" SUB-M@Example.COM ");
    expect(spelled).toBe("sub-m@example.com");
    expect(guard.key(spelled ?? "")).toBe(guard.key(M));
  });

  test("old confirmation held, confirm, detect, unsubscribe, re-subscribe", async () => {
    const f = subscriptionFixture();
    fx = f;
    seed(f);
    subscribe(f, M, 0);
    await letLoopRun();
    const m1 = idOf(f, M);
    f.clock.t = 10;
    expect(f.ops.confirm(confirmTokenOf(f.mailer.calls[0] ?? fail()), 10)).toBe("ok");
    const before = f.detections.n;
    detect(f, 20);
    await letLoopRun();
    expect(f.detections.n).toBe(before + 1);
    expect(f.store.pendingEventCount()).toBe(1);
    expect(f.mailer.calls).toHaveLength(1);
    unsubscribe(f, m1, 30);
    subscribe(f, M, 40);
    await letLoopRun();
    const m2 = idOf(f, M);
    expect(m2).not.toBe(m1);
    expect(f.worker.size()).toBe(2);
    expect(f.mailer.calls).toHaveLength(1);
    expectBound(f);
    f.clock.t = 50;
    f.mailer.auto = "success";
    f.mailer.calls[0]?.resolve();
    await letLoopRun();
    expect(f.store.pendingEventCount()).toBe(0);
    expect(f.incidentOutcomes).toEqual([]);
    expect(f.mailer.calls.map((c) => c.to)).toEqual([M, M]);
    expect(f.mailer.calls[1]?.message.subject).toBe(CONFIRM_SUBJECT);
    expect(f.mailer.order).toEqual([`start:${M}`, `settle:${M}`, `start:${M}`, `settle:${M}`]);
    expect(f.mailer.maxInFlight.get(M)).toBe(1);
    expect(deliveriesOf(f, m1, m2)).toBe(0);
  });

  test.each([
    { name: "success", settle: "success", outcomes: ["success"] },
    { name: "permanent 550", settle: "permanent", outcomes: ["failure"] },
    { name: "temporary failure", settle: "temporary", outcomes: ["failure"] },
    { name: "timeout", settle: "timeout", outcomes: ["failure"] },
    { name: "stop", settle: "stop", outcomes: [] },
  ])("mirrored: old incident send held, new confirmation queued; $name", async (c) => {
    const { f, m1 } = await heldIncident();
    subscribe(f, M, 40);
    const m2 = idOf(f, M);
    subscribe(f, N, 41);
    await letLoopRun();
    expect(f.mailer.calls.map((call) => call.to)).toEqual([M, M, N]);
    expect(f.worker.size()).toBe(2);
    f.mailer.calls[2]?.resolve();
    await letLoopRun();
    expect(callsTo(f, M)).toBe(2);
    expectBound(f);
    f.clock.t = 50;
    const held = f.mailer.calls[1] ?? fail();
    if (c.settle === "success") held.resolve();
    else if (c.settle === "permanent")
      held.reject(new PermanentDeliveryError("550", { status: 550 }));
    else if (c.settle === "temporary") held.reject(new Error("421 try later"));
    else if (c.settle === "timeout") held.reject(new Error("smtp attempt timed out after 5000 ms"));
    else {
      f.guard.stop();
      await f.incidents.stop();
      await f.worker.stop();
    }
    await letLoopRun();
    expect(f.incidentOutcomes).toEqual([...c.outcomes]);
    if (c.settle === "stop") {
      expect(held.smtp.signal?.aborted).toBe(true);
      expect(callsTo(f, M)).toBe(2);
      expect(f.guard.size()).toBe(0);
    } else {
      expect(f.mailer.calls[3]?.to).toBe(M);
      expect(f.mailer.calls[3]?.message.subject).toBe(CONFIRM_SUBJECT);
      expect(f.mailer.order.indexOf(`settle:${M}`, 2)).toBeLessThan(
        f.mailer.order.lastIndexOf(`start:${M}`),
      );
      // M2's attempt holds the entry right after it started.
      expect(f.guard.size()).toBe(1);
      expect(
        countRows(
          f.path,
          "SELECT count(*) AS n FROM events WHERE key = ? AND status = 'done' AND passes = 1",
          E1,
        ),
      ).toBe(1);
      expect(f.sleep.record).toEqual([]);
      f.mailer.calls[3]?.resolve();
      await letLoopRun();
    }
    expect(deliveriesOf(f, m1, m2)).toBe(0);
    expectBound(f);
    expect(f.mailer.maxInFlight.get(M)).toBe(1);
  });

  test("self-check: a guard keyed per generation lets 2 sends to M overlap", async () => {
    const real = createMailboxGuard();
    let generation = 0;
    const wrong: MailboxGuard = {
      ...real,
      key: (address) => {
        generation += 1;
        return `${real.key(address)}:${generation}`;
      },
    };
    const { f } = await heldIncident(wrong);
    subscribe(f, M, 40);
    await letLoopRun();
    expect(f.mailer.maxInFlight.get(M)).toBe(2);
    f.mailer.auto = "success";
    for (const call of f.mailer.calls) call.resolve();
    await letLoopRun();
  });

  test("same sequence without the unsubscribe: the incident mail waits for the confirmation", async () => {
    const f = subscriptionFixture();
    fx = f;
    seed(f);
    subscribe(f, M, 0);
    await letLoopRun();
    f.clock.t = 10;
    expect(f.ops.confirm(confirmTokenOf(f.mailer.calls[0] ?? fail()), 10)).toBe("ok");
    detect(f, 20);
    await letLoopRun();
    expect(f.mailer.calls).toHaveLength(1);
    f.mailer.auto = "success";
    f.mailer.calls[0]?.resolve();
    await letLoopRun();
    expect(f.mailer.calls.map((c) => c.message.subject)).toEqual([
      CONFIRM_SUBJECT,
      INCIDENT_SUBJECT,
    ]);
    expect(f.mailer.maxInFlight.get(M)).toBe(1);
    expect(f.incidentOutcomes).toEqual(["success"]);
  });

  test("confirm during the retry wait: gauge 0 at once and no attempt 2", async () => {
    const f = subscriptionFixture();
    fx = f;
    subscribe(f, M, 0);
    await letLoopRun();
    f.clock.t = 5;
    const first = f.mailer.calls[0] ?? fail();
    first.reject(new Error("421 try later"));
    await letLoopRun();
    expect(f.worker.size()).toBe(1);
    f.clock.t = 10;
    expect(f.ops.confirm(confirmTokenOf(first), 10)).toBe("ok");
    expect(f.worker.size()).toBe(0);
    f.clock.t = 5000;
    f.sleep.resolveAll();
    await letLoopRun();
    expect(callsTo(f, M)).toBe(1);
    expect(f.outcomes).toEqual([]);
  });

  test("worker 1 is not blocked by another mailbox's incident send", async () => {
    const f = subscriptionFixture();
    fx = f;
    seed(f);
    f.mailer.auto = "success";
    subscribe(f, M, 0);
    await letLoopRun();
    expect(f.ops.confirm(confirmTokenOf(f.mailer.calls[0] ?? fail()), 10)).toBe("ok");
    f.mailer.auto = undefined;
    detect(f, 20);
    await letLoopRun();
    subscribe(f, N, 30);
    await letLoopRun();
    expect(f.mailer.calls.map((c) => c.to)).toEqual([M, M, N]);
    expectBound(f);
    for (const call of f.mailer.calls) call.resolve();
    await letLoopRun();
  });

  test("held mailbox: no elapsed wake, other mailboxes progress (both real workers)", async () => {
    const { f } = await heldIncident();
    // Step 1: M2 (notBefore 0) is held by M1's open incident send.
    subscribe(f, M, 40);
    await letLoopRun();
    const s0 = f.worker.selections;
    await letLoopRun();
    expect(f.worker.selections - s0).toBe(0);
    expect(f.sleep.record).toEqual([]);
    expect(callsTo(f, M)).toBe(2);
    // Step 2.
    subscribe(f, N, 41);
    await letLoopRun();
    expect(f.mailer.calls[2]?.to).toBe(N);
    f.clock.t = 42;
    f.mailer.calls[2]?.reject(new Error("421 try later"));
    await letLoopRun();
    expect(f.sleep.record).toEqual([1000]);
    expect(f.sleep.pending()).toBe(1);
    const s1 = f.worker.selections;
    await letLoopRun();
    expect(f.worker.selections - s1).toBe(0);
    // Step 3.
    f.clock.t = 500;
    f.sleep.resolveAll();
    await letLoopRun();
    expect(f.sleep.record).toEqual([1000, 542]);
    expect(f.sleep.pending()).toBe(1);
    expect(callsTo(f, N)).toBe(1);
    expect(callsTo(f, M)).toBe(2);
    // Step 4: ready at the exact deadline, no sleep of 0.
    f.clock.t = 1042;
    f.sleep.resolveAll();
    await letLoopRun();
    expect(f.mailer.calls[3]?.to).toBe(N);
    expect(f.sleep.record).toEqual([1000, 542]);
    f.mailer.calls[3]?.resolve();
    await letLoopRun();
    // Step 5: the guard's settle starts M2, not a sleep.
    f.clock.t = 1100;
    f.mailer.calls[1]?.resolve();
    await letLoopRun();
    expect(f.mailer.calls[4]?.to).toBe(M);
    expect(f.mailer.calls[4]?.message.subject).toBe(CONFIRM_SUBJECT);
    expect(f.sleep.record).toEqual([1000, 542]);
    expect(f.mailer.maxInFlight.get(M)).toBe(1);
    expect(f.sleep.record.every((ms) => ms >= 1)).toBe(true);
    f.mailer.calls[4]?.resolve();
    await letLoopRun();
    f.guard.stop();
    await f.incidents.stop();
    await f.worker.stop();
    expect(f.sleep.pending()).toBe(0);
  });

  test("self-check: a worker that sleeps until the earliest notBefore of all jobs fails", async () => {
    const sleep = recordingSleep();
    const jobs = [{ notBefore: 0, isHeld: true }];
    const now = 40;
    let selections = 0;
    while (selections < 1000) {
      selections += 1;
      if (jobs.some((j) => j.notBefore <= now && !j.isHeld)) break;
      const earliest = Math.min(...jobs.map((j) => j.notBefore));
      await sleep.sleep(earliest - now, new AbortController().signal);
    }
    expect(selections).toBe(1000);
    expect(sleep.record.length).toBeGreaterThan(0);
    expect(sleep.record.some((ms) => ms < 1)).toBe(true);
  });

  test("stop while worker 2 waits on M's entry: E1 stays pending, no send, no delivery", async () => {
    const f = subscriptionFixture();
    fx = f;
    insertConfirmed(f.store, { id: "m".repeat(22), email: M, confirmedAt: 0 });
    seed(f);
    const key = f.guard.key(M);
    const owner = f.guard.tryAcquire(key) ?? 0;
    detect(f, 20);
    await letLoopRun();
    f.guard.stop();
    await f.incidents.stop();
    expect(callsTo(f, M)).toBe(0);
    expect(
      countRows(
        f.path,
        "SELECT count(*) AS n FROM events WHERE key = ? AND status = 'pending'",
        E1,
      ),
    ).toBe(1);
    expect(deliveriesOf(f, "m".repeat(22))).toBe(0);
    f.guard.release(key, owner);
  });
});
