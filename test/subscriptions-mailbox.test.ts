import { afterEach, describe, expect, test } from "bun:test";
import { normalizeSubscriberEmail } from "@lorenzh/pulse-contract";
import { createMailboxGuard } from "../src/mailbox-guard.ts";
import {
  letLoopRun,
  type SubscriptionFixture,
  subscriptionFixture,
} from "./subscriptions-support.ts";

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
  await fx?.close();
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
