import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ChannelDelivery } from "../src/delivery.ts";
import { Ledger } from "../src/ledger.ts";
import type { Notification } from "../src/types.ts";
import { spyLogger } from "./support.ts";

function note(key: string): Notification {
  return {
    key,
    event: "opened",
    incidentId: 1,
    checkId: "c",
    checkName: "C",
    reason: null,
    time: "2026-01-01T00:00:00.000Z",
    timeMs: 0,
  };
}

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function setup(
  send: (n: Notification, signal?: AbortSignal) => Promise<void>,
  extra: { retryMaxDelayMs?: number; retryAttempts?: number } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "notify-del-"));
  dirs.push(dir);
  const ledger = new Ledger(join(dir, "s.json"));
  const logger = spyLogger();
  const sleeps: number[] = [];
  const delivery = new ChannelDelivery({
    channelId: "ch",
    send,
    ledger,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    retryDelayMs: 250,
    ...extra,
    logger,
  });
  return { ledger, logger, sleeps, delivery };
}

test("retries with doubling delays up to the cap, then records failure", async () => {
  let calls = 0;
  const { ledger, logger, sleeps, delivery } = setup(
    async () => {
      calls++;
      throw new Error("boom");
    },
    { retryMaxDelayMs: 1000, retryAttempts: 6 },
  );
  delivery.enqueue(note("1:opened"));
  await delivery.idle();
  assert.equal(calls, 6);
  assert.deepEqual(sleeps, [250, 500, 1000, 1000, 1000]);
  assert.equal(ledger.status("ch", "1:opened"), "failed");
  const err = logger.entries.find((e) => e.level === "error");
  assert.deepEqual(
    { ...err?.fields },
    { channel: "ch", key: "1:opened", attempts: 6, error: "boom" },
  );
});

test("defaults to 12 attempts and 0 retries without end", async () => {
  let calls = 0;
  const a = setup(async () => {
    calls++;
    throw new Error("boom");
  });
  a.delivery.enqueue(note("1:opened"));
  await a.delivery.idle();
  assert.equal(calls, 12);

  calls = 0;
  const b = setup(
    async () => {
      if (++calls < 40) throw new Error("down");
    },
    { retryAttempts: 0 },
  );
  b.delivery.enqueue(note("1:opened"));
  await b.delivery.idle();
  assert.equal(calls, 40);
  assert.equal(b.ledger.status("ch", "1:opened"), "delivered");
});

test("delivers after a receiver outage of 10 failed attempts", async () => {
  let calls = 0;
  const { ledger, delivery } = setup(async () => {
    if (++calls <= 10) throw new Error("down");
  });
  delivery.enqueue(note("1:opened"));
  await delivery.idle();
  assert.equal(ledger.status("ch", "1:opened"), "delivered");
});

test("failure logs carry channel, code and cause", async () => {
  const { logger, delivery } = setup(
    async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      });
    },
    { retryAttempts: 2 },
  );
  delivery.enqueue(note("1:opened"));
  await delivery.idle();
  for (const msg of ["delivery attempt failed", "notification delivery failed"]) {
    const entry = logger.entries.find((e) => e.msg === msg);
    assert.equal(entry?.fields.channel, "ch");
    assert.equal(entry?.fields.code, "ECONNREFUSED");
    assert.equal(entry?.fields.cause, "connect ECONNREFUSED");
  }
});

test("stop during a retry sleep leaves the key pending and sends no more", async () => {
  let calls = 0;
  const dir = mkdtempSync(join(tmpdir(), "notify-del-"));
  dirs.push(dir);
  const ledger = new Ledger(join(dir, "s.json"));
  const delivery = new ChannelDelivery({
    channelId: "ch",
    send: async () => {
      calls++;
      throw new Error("down");
    },
    ledger,
    // Never resolves on its own: only the abort can end it.
    sleep: () => new Promise(() => {}),
    retryDelayMs: 250,
    logger: spyLogger(),
  });
  delivery.enqueue(note("1:opened"));
  while (calls === 0) await new Promise((r) => setImmediate(r));
  delivery.stop();
  await delivery.idle();
  assert.equal(calls, 1);
  assert.equal(ledger.status("ch", "1:opened"), "pending");
});

test("a pending key with a payload is resent without a new claim", async () => {
  const sent: string[] = [];
  const { ledger, delivery } = setup(async (n) => {
    sent.push(n.key);
  });
  ledger.claim("ch", "1:opened", note("1:opened"));
  delivery.enqueue(note("1:opened"));
  await delivery.idle();
  assert.deepEqual(sent, ["1:opened"]);
  assert.equal(ledger.status("ch", "1:opened"), "delivered");
});

test("a throwing claim is logged, nothing is sent and the key is released", async () => {
  let calls = 0;
  const released: string[] = [];
  const logger = spyLogger();
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "notify-del-")), "s.json"));
  ledger.claim = () => {
    throw new Error("disk full");
  };
  const delivery = new ChannelDelivery({
    channelId: "ch",
    send: async () => {
      calls++;
    },
    ledger,
    sleep: async () => {},
    retryDelayMs: 1,
    logger,
    release: (key) => released.push(key),
  });
  delivery.enqueue(note("1:opened"));
  await delivery.idle();
  assert.equal(calls, 0);
  assert.deepEqual(released, ["1:opened"]);
  assert.equal(logger.entries.find((e) => e.level === "error")?.fields.error, "disk full");
});

test("a throwing settle is logged and leaves the key pending", async () => {
  const logger = spyLogger();
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "notify-del-")), "s.json"));
  ledger.settle = () => {
    throw new Error("disk full");
  };
  const delivery = new ChannelDelivery({
    channelId: "ch",
    send: async () => {},
    ledger,
    sleep: async () => {},
    retryDelayMs: 1,
    logger,
  });
  delivery.enqueue(note("1:opened"));
  await delivery.idle();
  assert.equal(ledger.status("ch", "1:opened"), "pending");
  assert.ok(logger.entries.some((e) => e.msg.startsWith("ledger settle failed")));
});

test("stops retrying after a success", async () => {
  let calls = 0;
  const { ledger, sleeps, delivery } = setup(async () => {
    if (++calls < 3) throw new Error("no");
  });
  delivery.enqueue(note("1:opened"));
  await delivery.idle();
  assert.equal(calls, 3);
  assert.equal(sleeps.length, 2);
  assert.equal(ledger.status("ch", "1:opened"), "delivered");
});

test("sends in FIFO order and continues after a failed event", async () => {
  const order: string[] = [];
  const { ledger, delivery } = setup(async (n) => {
    order.push(n.key);
    if (n.key === "1:opened") throw new Error("x");
  });
  delivery.enqueue(note("1:opened"));
  delivery.enqueue(note("1:resolved"));
  await delivery.idle();
  assert.equal(order.at(-1), "1:resolved");
  assert.equal(order.filter((k) => k === "1:opened").length, 12);
  assert.equal(ledger.status("ch", "1:resolved"), "delivered");
});

test("never re-sends a key that is already recorded", async () => {
  let calls = 0;
  const { ledger, delivery } = setup(async () => {
    calls++;
  });
  ledger.seed("ch", ["1:opened"]);
  delivery.enqueue(note("1:opened"));
  await delivery.idle();
  assert.equal(calls, 0);
});
