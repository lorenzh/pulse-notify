import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { detectEvents, seedKeys } from "../src/detector.ts";
import { Ledger } from "../src/ledger.ts";
import { Notifier } from "../src/notifier.ts";
import type { Notification, Sleep } from "../src/types.ts";
import {
  asRecord,
  type FakeApi,
  httpCheck,
  incident,
  type Receiver,
  spyLogger,
  startFakeApi,
  startReceiver,
} from "./support.ts";

const OPENED = Date.UTC(2026, 0, 1, 12, 0, 0);
const MINUTE = 60_000;

let api: FakeApi;
let rx: Receiver;
let dir: string;
let clock: number;
let logger = spyLogger();

beforeEach(async () => {
  api = await startFakeApi();
  rx = await startReceiver();
  dir = mkdtempSync(join(tmpdir(), "notify-rem-"));
  clock = OPENED;
  logger = spyLogger();
  api.checks = [httpCheck("example", "Example site")];
});

afterEach(async () => {
  await api.close();
  await rx.close();
  rmSync(dir, { recursive: true, force: true });
});

let current: Ledger | undefined;

/** Writes the batched changes of the last ledger and returns the state file. */
async function savedState(): Promise<{
  channels: Record<string, Record<string, { status: string }>>;
  version: number;
}> {
  await current?.flush();
  return JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
}

function make(sleep: Sleep = async () => {}): Notifier {
  current = new Ledger(join(dir, "state.json"));
  return new Notifier({
    config: {
      channels: [{ id: "hook", type: "webhook", url: rx.url, remindEverySeconds: 600 }],
    },
    apiUrl: api.url,
    ledger: current,
    logger,
    retryDelayMs: 1,
    retryAttempts: 5,
    sleep,
    schedule: () => () => {},
    now: () => clock,
  });
}

function keys(): string[] {
  return rx.accepted().map((r) => String(asRecord(r.body).key));
}

async function poll(n: Notifier): Promise<void> {
  await n.tick();
  await n.idle();
}

test("one reminder per interval, with the age and the reminder time", async () => {
  const n = make();
  await poll(n); // seeds
  api.incidents = [incident({ id: 1, openedAt: OPENED })];
  await poll(n);
  assert.deepEqual(keys(), ["1:opened"]);
  clock = OPENED + 9 * MINUTE;
  await poll(n);
  assert.deepEqual(keys(), ["1:opened"]);
  clock = OPENED + 10 * MINUTE;
  await poll(n);
  await poll(n);
  assert.deepEqual(keys(), ["1:opened", "1:reminder:1"]);
  const body = asRecord(rx.accepted()[1]?.body);
  assert.equal(body.event, "reminder");
  assert.equal(body.timeMs, clock);
  assert.equal(body.time, new Date(clock).toISOString());
  assert.equal(body.openedMs, OPENED);
  assert.equal(rx.accepted()[1]?.headers["idempotency-key"], "1:reminder:1");
});

test("after a restart no reminder is repeated; the next interval sends one", async () => {
  let n = make();
  await poll(n);
  api.incidents = [incident({ id: 1, openedAt: OPENED })];
  clock = OPENED + 10 * MINUTE;
  await poll(n);
  n = make();
  await poll(n);
  assert.deepEqual(keys(), ["1:opened", "1:reminder:1"]);
  clock = OPENED + 20 * MINUTE;
  await poll(n);
  assert.deepEqual(keys(), ["1:opened", "1:reminder:1", "1:reminder:2"]);
});

test("missed intervals are not caught up: only the latest reminder is sent", async () => {
  const n = make();
  await poll(n);
  api.incidents = [incident({ id: 1, openedAt: OPENED })];
  await poll(n);
  clock = OPENED + 55 * MINUTE;
  await poll(n);
  assert.deepEqual(keys(), ["1:opened", "1:reminder:5"]);
});

test("older reminder keys are pruned from the ledger", async () => {
  const n = make();
  await poll(n);
  api.incidents = [incident({ id: 1, openedAt: OPENED })];
  await poll(n);
  clock = OPENED + 10 * MINUTE;
  await poll(n);
  clock = OPENED + 20 * MINUTE;
  await poll(n);
  const state = await savedState();
  assert.deepEqual(
    Object.keys(state.channels.hook ?? {}).sort((a, b) => a.localeCompare(b)),
    ["1:opened", "1:reminder:2"],
  );
  assert.equal(state.version, 2);
});

test("a resolved incident gets no reminder", async () => {
  const n = make();
  await poll(n);
  api.incidents = [incident({ id: 1, openedAt: OPENED })];
  await poll(n);
  api.incidents = [incident({ id: 1, openedAt: OPENED, resolvedAt: OPENED + 5 * MINUTE })];
  clock = OPENED + 30 * MINUTE;
  await poll(n);
  assert.deepEqual(keys(), ["1:opened", "1:resolved"]);
});

test("a reminder still retrying when the incident resolves is dropped before send", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const n = make(async () => gate);
  await poll(n);
  api.incidents = [incident({ id: 1, openedAt: OPENED })];
  await poll(n);
  rx.up = false;
  clock = OPENED + 10 * MINUTE;
  await n.tick(); // the reminder fails once and waits for a retry
  await logger.waitFor((e) => e.msg === "delivery attempt failed");
  api.incidents = [incident({ id: 1, openedAt: OPENED, resolvedAt: clock + MINUTE })];
  await n.tick();
  rx.up = true;
  release();
  await n.idle();
  assert.deepEqual(keys(), ["1:opened", "1:resolved"]);
  const state = await savedState();
  assert.equal(state.channels.hook?.["1:reminder:1"]?.status, "dropped");
  assert.ok(logger.entries.some((e) => e.msg === "stale reminder dropped"));
});

test("a new channel is seeded with the current reminder index", async () => {
  api.incidents = [incident({ id: 1, openedAt: OPENED })];
  clock = OPENED + 35 * MINUTE; // 3.5 intervals
  const n = make();
  await poll(n); // seeds, sends nothing
  assert.deepEqual(keys(), []);
  await poll(n);
  assert.deepEqual(keys(), []);
  clock = OPENED + 40 * MINUTE;
  await poll(n);
  assert.deepEqual(keys(), ["1:reminder:4"]);
});

test("detector: reminders are off without a plan and wait for opened", () => {
  const open = incident({ id: 7, openedAt: OPENED });
  const plan = { everyMs: 600_000, nowMs: OPENED + 25 * MINUTE };
  assert.deepEqual(
    detectEvents([open], () => true).map((e) => e.key),
    [],
  );
  assert.deepEqual(
    detectEvents([open], (k) => k === "7:opened", plan).map((e) => e.key),
    ["7:reminder:2"],
  );
  assert.deepEqual(
    detectEvents([open], (k) => k !== "7:opened", plan).map((e) => e.key),
    ["7:opened"],
  );
  assert.deepEqual(seedKeys([open], plan), ["7:opened", "7:reminder:2"]);
  assert.deepEqual(seedKeys([open]), ["7:opened"]);
});

function reminder(n: number): Notification {
  return {
    key: `1:reminder:${n}`,
    event: "reminder",
    incidentId: 1,
    checkId: "example",
    checkName: "Example site",
    reason: null,
    time: new Date(OPENED).toISOString(),
    timeMs: OPENED,
    openedMs: OPENED,
  };
}

test("a reminder pending at restart of a resolved incident is dropped, not sent", async () => {
  const ledger = new Ledger(join(dir, "state.json"));
  ledger.seed("hook", ["1:opened"]);
  ledger.claim("hook", "1:reminder:1", reminder(1));
  api.incidents = [incident({ id: 1, openedAt: OPENED, resolvedAt: OPENED + MINUTE })];
  clock = OPENED + 10 * MINUTE;
  const n = make();
  n.start();
  await n.tick();
  await n.idle();
  await n.stop();
  assert.deepEqual(keys(), ["1:resolved"]);
  const state = await savedState();
  assert.equal(state.channels.hook?.["1:reminder:1"]?.status, "dropped");
});

test("a held reminder of an open incident is sent after the first poll", async () => {
  const ledger = new Ledger(join(dir, "state.json"));
  ledger.seed("hook", ["1:opened"]);
  ledger.claim("hook", "1:reminder:1", reminder(1));
  api.incidents = [incident({ id: 1, openedAt: OPENED })];
  clock = OPENED + 10 * MINUTE;
  const n = make();
  n.start();
  await n.idle();
  assert.deepEqual(keys(), []);
  await n.tick();
  await n.idle();
  await n.stop();
  assert.deepEqual(keys(), ["1:reminder:1"]);
});

test("after failed intervals only the latest reminder is delivered", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const n = make(async () => gate);
  await poll(n);
  api.incidents = [incident({ id: 1, openedAt: OPENED })];
  await poll(n);
  rx.up = false;
  for (let i = 1; i <= 4; i++) {
    clock = OPENED + i * 10 * MINUTE;
    await n.tick();
    if (i === 1) await logger.waitFor((e) => e.msg === "delivery attempt failed");
  }
  rx.up = true;
  release();
  await n.idle();
  await n.stop();
  assert.deepEqual(keys(), ["1:opened", "1:reminder:4"]);
});

test("a failed newer reminder still supersedes an older pending one", async () => {
  const ledger = new Ledger(join(dir, "state.json"));
  ledger.seed("hook", ["1:opened"]);
  ledger.claim("hook", "1:reminder:1", reminder(1));
  ledger.claim("hook", "1:reminder:2", reminder(2));
  ledger.settle("hook", "1:reminder:2", "failed");
  await ledger.flush();
  api.incidents = [incident({ id: 1, openedAt: OPENED })];
  clock = OPENED + 10 * MINUTE;
  const n = make();
  n.start();
  await n.tick();
  await n.idle();
  await n.stop();
  assert.deepEqual(keys(), []);
});
