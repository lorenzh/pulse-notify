import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.ts";
import { Metrics } from "../src/metrics.ts";
import { Notifier } from "../src/notifier.ts";
import type { Notification } from "../src/types.ts";
import {
  asRecord,
  type FakeApi,
  httpCheck,
  incident,
  manualIncident,
  type SpyLogger,
  spyLogger,
  startFakeApi,
} from "./support.ts";

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

let api: FakeApi;
let dir: string;
let logger: SpyLogger;
let metrics: Metrics;
let clock: number;

beforeEach(async () => {
  api = await startFakeApi();
  dir = mkdtempSync(join(tmpdir(), "notify-feeds-"));
  logger = spyLogger();
  metrics = new Metrics(["out"], () => 0);
  clock = T0;
});
afterEach(async () => {
  await api.close();
  rmSync(dir, { recursive: true, force: true });
});

const statePath = (): string => join(dir, "state.json");

function make(ledger = new Ledger(statePath(), { now: () => clock })): Notifier {
  return new Notifier({
    config: { channels: [{ id: "out", type: "file", path: join(dir, "out.jsonl") }] },
    apiUrl: api.url,
    ledger,
    logger,
    metrics,
    now: () => clock,
    stateRetentionDays: 1,
    sleep: async () => {},
    schedule: () => () => {},
  });
}

async function poll(n: Notifier): Promise<void> {
  await n.tick();
  await n.idle();
}

function delivered(): Record<string, unknown>[] {
  try {
    return readFileSync(join(dir, "out.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => asRecord(JSON.parse(l)));
  } catch {
    // No file means nothing was delivered.
    return [];
  }
}

const keys = (): unknown[] => delivered().map((e) => e.key);

const pollFailures = (): Record<string, unknown>[] =>
  logger.entries.filter((e) => e.msg === "api poll failed").map((e) => e.fields);

const fail = (path: string, status = 500): void => {
  api.failingPaths.set(path, status);
};

test("checks 500: incidents keep the name from the last good read", async () => {
  api.checks = [httpCheck("c1", "API")];
  const n = make();
  await poll(n);
  fail("/checks");
  api.incidents = [incident({ id: 1, checkId: "c1" })];
  await poll(n);
  await poll(n);

  assert.deepEqual(
    delivered().map((e) => [e.key, e.checkName]),
    [["1:opened", "API"]],
  );
  const failures = pollFailures();
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.feed, "checks");
  assert.equal(failures[0]?.error, "GET checks returned 500");
  assert.match(
    metrics.render(),
    /^pulse_notify_feed_polls_total\{feed="checks",outcome="error"\} 2$/m,
  );
  assert.equal(api.requested.filter((p) => p === "/checks").length, 3);
});

test("checks 500 with no good read ever: incidents use the check id", async () => {
  fail("/checks");
  api.checks = [httpCheck("c1", "API")];
  const n = make();
  await poll(n);
  api.incidents = [incident({ id: 1, checkId: "c1" })];
  await poll(n);
  assert.deepEqual(
    delivered().map((e) => [e.key, e.checkName]),
    [["1:opened", "c1"]],
  );
});

test("a good checks read replaces the names: a dropped check falls back to its id", async () => {
  api.checks = [httpCheck("c1", "API")];
  const n = make();
  await poll(n);
  api.checks = [];
  api.incidents = [incident({ id: 1, checkId: "c1" })];
  await poll(n);
  assert.equal(delivered()[0]?.checkName, "c1");
});

test("checks 500 then 503 logs twice; 500, ok, 500 logs twice", async () => {
  const n = make();
  fail("/checks", 500);
  await poll(n);
  fail("/checks", 503);
  await poll(n);
  assert.deepEqual(
    pollFailures().map((f) => f.error),
    ["GET checks returned 500", "GET checks returned 503"],
  );

  api.failingPaths.clear();
  await poll(n);
  logger.entries.length = 0;
  fail("/checks", 500);
  await poll(n);
  api.failingPaths.clear();
  await poll(n);
  assert.ok(logger.entries.some((e) => e.msg === "api feed recovered"));
  fail("/checks", 500);
  await poll(n);
  await poll(n);
  assert.deepEqual(
    pollFailures().map((f) => f.error),
    ["GET checks returned 500", "GET checks returned 500"],
  );
});

test("manual-incidents 500: automatic incidents go on, manual keys are kept", async () => {
  api.manualIncidents = [manualIncident({ id: 7 })];
  api.incidents = [incident({ id: 5, resolvedAt: T0 + 60_000 })];
  const ledger = new Ledger(statePath(), { now: () => clock });
  const n = make(ledger);
  await poll(n); // seeds 5:opened, 5:resolved and manual:7:opened at T0
  assert.equal(ledger.status("out", "manual:7:opened"), "seeded");

  fail("/manual-incidents");
  api.manualIncidents = [];
  api.incidents = [incident({ id: 1 })];
  clock = T0 + 2 * DAY_MS; // the next prune runs and the seeded keys are old
  await poll(n);
  await poll(n);

  assert.deepEqual(keys(), ["1:opened"]);
  assert.equal(ledger.status("out", "5:opened"), undefined, "prune ran");
  assert.equal(ledger.status("out", "manual:7:opened"), "seeded");
  assert.equal(ledger.status("out", "manual:7:resolved"), undefined);
  const failures = pollFailures();
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.feed, "manual-incidents");
});

function reminder(n: number): Notification {
  return {
    key: `1:reminder:${n}`,
    event: "reminder",
    incidentId: 1,
    checkId: "example",
    checkName: "Example site",
    reason: null,
    time: new Date(T0).toISOString(),
    timeMs: T0,
    openedMs: T0,
  };
}

test("incidents 500: manual updates go on, held reminders and legacy keys wait", async () => {
  // A pending key without a stored notification, as an older version wrote it.
  writeFileSync(
    statePath(),
    JSON.stringify({
      version: 2,
      channels: {
        out: {
          "1:opened": { status: "delivered", at: T0 },
          "manual:7:opened": { status: "seeded", at: T0 },
          "9:opened": { status: "pending", at: T0 },
        },
      },
      manualFrom: { out: T0 },
    }),
  );
  const ledger = new Ledger(statePath(), { now: () => clock });
  ledger.claim("out", "1:reminder:1", reminder(1));
  const n = make(ledger);
  n.start();
  fail("/incidents");
  api.incidents = [incident({ id: 1 })];
  api.manualIncidents = [
    manualIncident({
      id: 7,
      status: "identified",
      updates: [
        { at: T0, status: "investigating", message: "We are looking." },
        { at: T0 + 60_000, status: "identified", message: "Found it." },
      ],
    }),
  ];
  await poll(n);

  assert.deepEqual(keys(), ["manual:7:update:2bffb0ddfacc85af28de2801bb32ef51"]);
  assert.equal(
    logger.entries.some((e) => e.msg.startsWith("pending notification cannot be rebuilt")),
    false,
  );
  const failures = pollFailures();
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.feed, "incidents");

  api.failingPaths.clear();
  await poll(n);
  await n.stop();
  assert.deepEqual(keys(), ["manual:7:update:2bffb0ddfacc85af28de2801bb32ef51", "1:reminder:1"]);
});

for (const path of ["/incidents", "/manual-incidents"]) {
  test(`a new channel is not seeded while ${path} fails, then seeded without a burst`, async () => {
    api.incidents = [incident({ id: 1 })];
    api.manualIncidents = [manualIncident({ id: 7 })];
    fail(path);
    const n = make();
    await poll(n);
    assert.equal(new Ledger(statePath()).hasChannel("out"), false);
    assert.ok(!logger.entries.some((e) => e.msg === "channel seeded with existing incidents"));

    api.failingPaths.clear();
    await poll(n);
    await poll(n);
    const ledger = new Ledger(statePath());
    assert.equal(ledger.status("out", "1:opened"), "seeded");
    assert.equal(ledger.status("out", "manual:7:opened"), "seeded");
    assert.deepEqual(keys(), []);
  });
}

for (const path of ["/incidents", "/checks", "/manual-incidents"]) {
  test(`health: ${path} failing alone fails the poll; one good poll resets`, async () => {
    const n = make();
    fail(path);
    await poll(n);
    await poll(n);
    assert.equal(n.pollHealth().consecutiveFailedPolls, 2);
    assert.match(metrics.render(), /^pulse_notify_polls_total\{outcome="error"\} 2$/m);
    api.failingPaths.clear();
    await poll(n);
    assert.equal(n.pollHealth().consecutiveFailedPolls, 0);
    assert.match(metrics.render(), /^pulse_notify_polls_total\{outcome="ok"\} 1$/m);
  });
}

test("health: a 404 on manual-incidents is a good poll and an ok feed read", async () => {
  api.manualIncidents = undefined;
  const n = make();
  await poll(n);
  assert.equal(n.pollHealth().consecutiveFailedPolls, 0);
  assert.equal(pollFailures().length, 0);
  const text = metrics.render();
  assert.match(text, /^pulse_notify_feed_polls_total\{feed="manual-incidents",outcome="ok"\} 1$/m);
  assert.match(text, /^pulse_notify_polls_total\{outcome="ok"\} 1$/m);
});
