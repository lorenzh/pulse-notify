import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PermanentDeliveryError } from "../src/errors.ts";
import { startCleanup } from "../src/subscriber-store.ts";
import {
  confirmTokenOf,
  fakeScheduler,
  letLoopRun,
  readStore,
  type SubscriptionFixture,
  subscriptionFixture,
  TEST_KEY,
  testUnsubscribeToken,
} from "./subscriptions-support.ts";

const A = "sub-a@example.com";
const B = "sub-b@example.com";
const C = "sub-c@example.com";

let fx: SubscriptionFixture | undefined;
afterEach(async () => {
  if (fx !== undefined) {
    // Map hygiene: every guard entry is released once the workers stopped.
    fx.guard.stop();
    await fx.worker.stop();
    expect(fx.guard.size()).toBe(0);
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
