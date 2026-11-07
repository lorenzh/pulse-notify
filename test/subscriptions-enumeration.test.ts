import { describe, expect, test } from "bun:test";
import { startSubscriptionServer } from "../src/subscription-server.ts";
import {
  confirmTokenOf,
  countRows,
  type FixtureOptions,
  letLoopRun,
  type SubscriptionFixture,
  subscriptionFixture,
  TEST_BEARER,
} from "./subscriptions-support.ts";

const K = "known@example.com";
const U = "unknown@example.com";

/** Subscribes K and lets its mail settle, so K is pending with an empty queue. */
async function pendingK(f: SubscriptionFixture, t: number): Promise<void> {
  expect(f.ops.subscribe(K, t)).toBe("queued");
  await letLoopRun();
  for (const call of f.mailer.calls) call.resolve();
  await letLoopRun();
}

async function confirmedK(f: SubscriptionFixture): Promise<void> {
  await pendingK(f, 0);
  const call = f.mailer.calls.find((c) => c.to === K);
  expect(f.ops.confirm(call === undefined ? "" : confirmTokenOf(call), 1)).toBe("ok");
}

interface Case {
  name: string;
  opts?: FixtureOptions;
  /** The clock value of the compared request (never advanced during it). */
  at: number;
  setup: (f: SubscriptionFixture) => Promise<void>;
  /** Literal effects after U's request. */
  uRows: number;
  uMails: number;
  limited?: string;
}

const fill = (f: SubscriptionFixture, n: number, from: number): void => {
  for (let i = 0; i < n; i += 1) f.ops.subscribe(`filler${i}@example.com`, from + i);
};

const CASES: Case[] = [
  { name: "below: confirmed", at: 600_000, setup: confirmedK, uRows: 2, uMails: 1 },
  {
    name: "below: pending in cooldown",
    at: 600_000,
    setup: (f) => pendingK(f, 1),
    uRows: 2,
    uMails: 1,
  },
  {
    name: "below: pending at send cap",
    at: 1_800_000,
    setup: async (f) => {
      for (const t of [0, 600_000, 1_200_000]) await pendingK(f, t);
    },
    uRows: 2,
    uMails: 1,
  },
  {
    name: "below: expired pending",
    at: 86_400_000,
    setup: (f) => pendingK(f, 0),
    uRows: 2,
    uMails: 1,
  },
  {
    name: "L1: confirmed",
    opts: { max: 2, maxPending: 2 },
    at: 600_000,
    setup: async (f) => {
      await confirmedK(f);
      fill(f, 1, 10);
    },
    uRows: 2,
    uMails: 0,
    limited: "capacity",
  },
  {
    name: "L1: pending in cooldown",
    opts: { max: 2, maxPending: 2 },
    at: 600_000,
    setup: async (f) => {
      await pendingK(f, 599_999);
      fill(f, 1, 10);
    },
    uRows: 2,
    uMails: 0,
    limited: "capacity",
  },
  {
    name: "L2: confirmed",
    opts: { max: 10, maxPending: 1 },
    at: 600_000,
    setup: async (f) => {
      await confirmedK(f);
      fill(f, 1, 10);
    },
    uRows: 2,
    uMails: 0,
    limited: "pending",
  },
  {
    name: "L2: the pending row in cooldown",
    opts: { max: 10, maxPending: 1 },
    at: 600_000,
    setup: (f) => pendingK(f, 599_999),
    uRows: 1,
    uMails: 0,
    limited: "pending",
  },
  {
    name: "L5: confirmed",
    opts: { confirmPerHour: 1 },
    at: 600_000,
    setup: confirmedK,
    uRows: 1,
    uMails: 0,
    limited: "window",
  },
  {
    name: "L5: pending past cooldown",
    opts: { confirmPerHour: 1 },
    at: 600_000,
    setup: (f) => pendingK(f, 0),
    uRows: 1,
    uMails: 0,
    limited: "window",
  },
  {
    name: "L6: confirmed",
    opts: { confirmPerHour: 1000 },
    at: 600_000,
    setup: async (f) => {
      await confirmedK(f);
      fill(f, 100, 10);
    },
    uRows: 101,
    uMails: 0,
    limited: "queue",
  },
  {
    name: "L6: pending past cooldown",
    opts: { confirmPerHour: 1000 },
    at: 600_000,
    setup: async (f) => {
      await pendingK(f, 0);
      fill(f, 100, 10);
    },
    uRows: 101,
    uMails: 0,
    limited: "queue",
  },
];

interface Raw {
  status: number;
  headers: string;
  body: string;
}

interface Run {
  raw: Raw;
  rows: number;
  newMails: number;
  limited: string[];
  kState: { id: string; state: string } | undefined;
}

/** One request against a fresh fixture: the answer and its literal effects. */
async function runOne(c: Case, email: string, closeStore = false): Promise<Run> {
  const f = subscriptionFixture(c.opts);
  try {
    await c.setup(f);
    await letLoopRun();
    const kBefore = f.store.subscriptionByEmail(K);
    const callsBefore = f.mailer.calls.length;
    const limitedBefore = f.limited.length;
    f.clock.t = c.at;
    if (closeStore) f.store.close();
    const server = await startSubscriptionServer({
      host: "127.0.0.1",
      port: 0,
      token: TEST_BEARER,
      ops: f.ops,
      now: f.clock.now,
      logError: () => {},
    });
    try {
      // The real 2000 ms limit only ends a wrong implementation that never answers.
      const res = await fetch(`http://127.0.0.1:${server.port}/subscriptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${TEST_BEARER}`, "content-type": "application/json" },
        body: JSON.stringify({ email }),
        signal: AbortSignal.timeout(2000),
      });
      const headers = [...res.headers.entries()]
        .filter(([name]) => name !== "date")
        .map(([name, value]) => `${name}: ${value}`)
        .sort((a, b) => a.localeCompare(b))
        .join("\n");
      const raw = { status: res.status, headers, body: await res.text() };
      // Immediate class: answered under a frozen clock while every mail stays held.
      expect(f.clock.t).toBe(c.at);
      expect(f.mailer.calls.slice(callsBefore).every((call) => !call.isSettled)).toBe(true);
      await letLoopRun();
      const kAfter = closeStore ? undefined : f.store.subscriptionByEmail(K);
      if (!closeStore && kBefore?.state === "confirmed") {
        expect(kAfter?.id).toBe(kBefore.id);
        expect(kAfter?.state).toBe("confirmed");
      }
      return {
        raw,
        rows: closeStore ? -1 : countRows(f.path, "SELECT count(*) AS n FROM subscriptions"),
        newMails: f.mailer.calls.length - callsBefore,
        limited: f.limited.slice(limitedBefore),
        kState: kAfter === undefined ? undefined : { id: kAfter.id, state: kAfter.state },
      };
    } finally {
      await server.close();
    }
  } finally {
    await f.close();
  }
}

describe("No enumeration (R8), notify", () => {
  for (const c of CASES) {
    test(c.name, async () => {
      for (const order of [
        [K, U],
        [U, K],
      ]) {
        const runs = new Map<string, Run>();
        for (const email of order) runs.set(email, await runOne(c, email));
        const k = runs.get(K);
        const u = runs.get(U);
        expect(k?.raw).toEqual(u?.raw as Raw);
        expect(u?.raw.status).toBe(202);
        expect(u?.raw.body).toBe('{"status":"accepted"}');
        expect(u?.rows).toBe(c.uRows);
        expect(u?.newMails).toBe(c.uMails);
        expect(u?.limited).toEqual(c.limited === undefined ? [] : [c.limited]);
      }
    });
  }

  test("a store error answers 503 unavailable for every address, byte-equal", async () => {
    const c = CASES[0] as Case;
    for (const order of [
      [K, U],
      [U, K],
    ]) {
      const raws = [];
      for (const email of order) raws.push((await runOne(c, email, true)).raw);
      expect(raws[0]).toEqual(raws[1] as Raw);
      expect(raws[0]?.status).toBe(503);
      expect(raws[0]?.body).toBe('{"error":"unavailable"}');
    }
  });

  test("the capacity counter grows by 1 per unknown request", async () => {
    const f = subscriptionFixture({ max: 2, maxPending: 2 });
    try {
      await confirmedK(f);
      fill(f, 1, 10);
      for (const [i, email] of ["u1@example.com", "u2@example.com", "u3@example.com"].entries()) {
        const result = f.ops.subscribe(email, 600_000 + i);
        expect(result).not.toBeInstanceOf(Promise);
        expect(f.limited).toHaveLength(i + 1);
      }
      expect(f.limited).toEqual(["capacity", "capacity", "capacity"]);
      expect(f.store.subscriptionByEmail(K)?.state).toBe("confirmed");
    } finally {
      await f.close();
    }
  });
});
