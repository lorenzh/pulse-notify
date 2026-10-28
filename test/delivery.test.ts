import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ChannelDelivery, MAX_ATTEMPTS } from "../src/delivery.ts";
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

function setup(send: (n: Notification) => Promise<void>) {
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
    logger,
  });
  return { ledger, logger, sleeps, delivery };
}

test("makes 4 attempts with the configured delay, then logs and records failure", async () => {
  let calls = 0;
  const { ledger, logger, sleeps, delivery } = setup(async () => {
    calls++;
    throw new Error("boom");
  });
  delivery.enqueue(note("1:opened"));
  await delivery.idle();
  assert.equal(MAX_ATTEMPTS, 4);
  assert.equal(calls, 4);
  assert.deepEqual(sleeps, [250, 250, 250]);
  assert.equal(ledger.status("ch", "1:opened"), "failed");
  const err = logger.entries.find((e) => e.level === "error");
  assert.deepEqual(
    { ...err?.fields },
    { channel: "ch", key: "1:opened", attempts: 4, error: "boom" },
  );
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
  assert.deepEqual(order, ["1:opened", "1:opened", "1:opened", "1:opened", "1:resolved"]);
  assert.equal(ledger.status("ch", "1:resolved"), "delivered");
});

test("never re-sends a key that is already recorded", async () => {
  let calls = 0;
  const { ledger, delivery } = setup(async () => {
    calls++;
  });
  ledger.claim("ch", "1:opened");
  delivery.enqueue(note("1:opened"));
  await delivery.idle();
  assert.equal(calls, 0);
});
