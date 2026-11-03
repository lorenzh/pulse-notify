import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.ts";
import { Notifier } from "../src/notifier.ts";
import type { ChannelConfig } from "../src/types.ts";
import {
  asRecord,
  type FakeApi,
  incident,
  manualIncident,
  type SpyLogger,
  spyLogger,
  startFakeApi,
} from "./support.ts";

type Filters = Pick<
  ChannelConfig,
  "checks" | "excludeChecks" | "components" | "excludeComponents" | "remindEverySeconds"
>;

const OPENED_AT = Date.UTC(2026, 0, 1, 12, 0, 0);
const CHANGED = "routing changed: history of newly routed checks skipped";
const MANUAL_CHANGED = "routing changed: history of newly routed manual incidents skipped";

let api: FakeApi;
let dir: string;
let logger: SpyLogger;
let clock: number;
let commits: number;
let isFailing: boolean;
let running: { notifier: Notifier; ledger: Ledger } | undefined;

beforeEach(async () => {
  api = await startFakeApi();
  dir = mkdtempSync(join(tmpdir(), "notify-routing-change-"));
  logger = spyLogger();
  clock = OPENED_AT + 60_000;
  commits = 0;
  isFailing = false;
  running = undefined;
});
afterEach(async () => {
  await shutdown();
  await api.close();
  rmSync(dir, { recursive: true, force: true });
});

const statePath = (): string => join(dir, "state.json");
const outPath = (): string => join(dir, "web.jsonl");

async function shutdown(): Promise<void> {
  if (!running) return;
  await running.notifier.stop();
  running.ledger.close();
  running = undefined;
}

/** Stops the running notifier and starts one with these filters on the same state path. */
async function start(filters: Filters): Promise<Notifier> {
  await shutdown();
  const beforeCommit = (): void => {
    if (isFailing) throw new Error("injected commit failure");
    commits++;
  };
  const ledger = new Ledger(statePath(), { now: () => clock, hooks: { beforeCommit } });
  const notifier = new Notifier({
    config: { channels: [{ id: "web", type: "file", path: outPath(), ...filters }] },
    apiUrl: api.url,
    ledger,
    logger,
    now: () => clock,
    sleep: async () => {},
    schedule: () => () => {},
  });
  running = { notifier, ledger };
  notifier.start();
  await notifier.idle();
  return notifier;
}

async function poll(n: Notifier): Promise<void> {
  await n.tick();
  await n.idle();
}

function sent(): string[] {
  try {
    return readFileSync(outPath(), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => String(asRecord(JSON.parse(l)).key));
  } catch {
    // No file means nothing was delivered.
    return [];
  }
}

function ledger(): Ledger {
  if (!running) throw new Error("not running");
  return running.ledger;
}

function changedLogs(msg = CHANGED): unknown[] {
  return logger.entries.filter((e) => e.msg === msg).map((e) => e.fields);
}

/** Channel seeded on an empty api with `before`, then incident 7 of `db` opens and resolves. */
async function historyOf7(before: Filters): Promise<Notifier> {
  const n = await start(before);
  await poll(n);
  api.incidents = [incident({ id: 7, checkId: "db" }), incident({ id: 8, checkId: "api" })];
  await poll(n);
  api.incidents[0] = incident({ id: 7, checkId: "db", resolvedAt: OPENED_AT + 1000 });
  await poll(n);
  assert.deepEqual(sent(), ["8:opened"]);
  return n;
}

test("widening checks seeds the history of the newly routed check and later events send", async () => {
  await historyOf7({ checks: ["api"] });
  let n = await start({ checks: ["api", "db"] });
  await poll(n);
  assert.deepEqual(sent(), ["8:opened"]);
  assert.equal(ledger().status("web", "7:opened"), "seeded");
  assert.equal(ledger().status("web", "7:resolved"), "seeded");
  assert.equal(ledger().status("web", "8:opened"), "delivered");
  assert.equal(ledger().checkRouting("web"), '{"checks":["api","db"],"excludeChecks":[]}');
  assert.deepEqual(changedLogs(), [{ channel: "web", incidents: 1 }]);
  await poll(n);
  n = await start({ checks: ["api", "db"] });
  await poll(n);
  assert.deepEqual(sent(), ["8:opened"]);
  api.incidents.push(incident({ id: 9, checkId: "db" }));
  await poll(n);
  assert.deepEqual(sent(), ["8:opened", "9:opened"]);
  assert.equal(changedLogs().length, 1);
});

const widenings: [string, Filters, Filters][] = [
  ["removing excludeChecks", { excludeChecks: ["db"] }, {}],
  ["a glob widening", { checks: ["api*"] }, { checks: ["*"] }],
];
for (const [name, before, after] of widenings) {
  test(`${name} sends none of the old history`, async () => {
    await historyOf7(before);
    const n = await start(after);
    await poll(n);
    assert.deepEqual(sent(), ["8:opened"]);
    assert.equal(ledger().status("web", "7:resolved"), "seeded");
  });
}

test("a due reminder of a newly routed open incident is seeded and the next interval sends", async () => {
  const n0 = await start({ checks: ["api"], remindEverySeconds: 600 });
  await poll(n0);
  api.incidents = [incident({ id: 7, checkId: "db" })];
  await poll(n0);
  clock = OPENED_AT + 700_000;
  const n = await start({ checks: ["api", "db"], remindEverySeconds: 600 });
  await poll(n);
  assert.deepEqual(sent(), []);
  assert.equal(ledger().status("web", "7:opened"), "seeded");
  assert.equal(ledger().status("web", "7:reminder:1"), "seeded");
  clock = OPENED_AT + 1_300_000;
  await poll(n);
  assert.deepEqual(sent(), ["7:reminder:2"]);
});

test("widening components seeds manual history and a later update sends", async () => {
  const creation = { at: OPENED_AT, status: "investigating", message: "c" } as const;
  const update = { at: OPENED_AT + 100, status: "identified", message: "u" } as const;
  const old = manualIncident({
    id: 5,
    componentIds: ["b"],
    status: "identified",
    updates: [creation, update],
  });
  api.manualIncidents = [];
  const n0 = await start({ components: ["a"] });
  await poll(n0);
  api.manualIncidents = [old];
  await poll(n0);
  assert.deepEqual(sent(), []);
  const n = await start({ components: ["a", "b"] });
  await poll(n);
  assert.deepEqual(sent(), []);
  assert.equal(ledger().status("web", "manual:5:opened"), "seeded");
  assert.equal(ledger().componentRouting("web"), '{"components":["a","b"],"excludeComponents":[]}');
  assert.deepEqual(changedLogs(MANUAL_CHANGED), [{ channel: "web", incidents: 1 }]);
  api.manualIncidents = [
    manualIncident({
      id: 5,
      componentIds: ["b"],
      status: "monitoring",
      updates: [creation, update, { at: OPENED_AT + 200, status: "monitoring", message: "m" }],
    }),
  ];
  await poll(n);
  assert.equal(sent().length, 1);
  assert.match(sent()[0] ?? "", /^manual:5:update:/);
});

test("a manual 404 keeps the stored component fingerprint", async () => {
  api.manualIncidents = [];
  const n0 = await start({ components: ["a"] });
  await poll(n0);
  api.manualIncidents = undefined;
  const n = await start({ components: ["a", "b"] });
  await poll(n);
  assert.equal(ledger().componentRouting("web"), '{"components":["a"],"excludeComponents":[]}');
});

test("a failed incidents feed after the restart sends nothing and keeps the old fingerprint", async () => {
  await historyOf7({ checks: ["api"] });
  api.failingPaths.set("/incidents", 500);
  const n = await start({ checks: ["api", "db"] });
  await poll(n);
  assert.deepEqual(sent(), ["8:opened"]);
  assert.equal(ledger().checkRouting("web"), '{"checks":["api"],"excludeChecks":[]}');
  api.failingPaths.clear();
  await poll(n);
  assert.deepEqual(sent(), ["8:opened"]);
  assert.equal(ledger().status("web", "7:opened"), "seeded");
});

test("a failed baseline write sends nothing and the next poll seeds", async () => {
  await historyOf7({ checks: ["api"] });
  const n = await start({ checks: ["api", "db"] });
  isFailing = true;
  await poll(n);
  isFailing = false;
  assert.deepEqual(sent(), ["8:opened"]);
  assert.ok(logger.entries.some((e) => e.msg === "ledger seed failed, the next poll retries"));
  assert.equal(ledger().status("web", "7:opened"), undefined);
  assert.equal(ledger().checkRouting("web"), '{"checks":["api"],"excludeChecks":[]}');
  await poll(n);
  assert.deepEqual(sent(), ["8:opened"]);
  assert.equal(ledger().status("web", "7:resolved"), "seeded");
});

test("reordered or duplicate lists write nothing", async () => {
  const n0 = await start({ checks: ["api", "db"] });
  await poll(n0);
  const n = await start({ checks: ["db", "api", "api"], excludeChecks: [] });
  commits = 0;
  await poll(n);
  assert.equal(commits, 0);
  assert.deepEqual(changedLogs(), []);
});

test("an unchanged restart still sends an incident that opened during the downtime", async () => {
  const n0 = await start({ checks: ["api"] });
  await poll(n0);
  await shutdown();
  api.incidents = [incident({ id: 10, checkId: "api" })];
  const n = await start({ checks: ["api"] });
  await poll(n);
  assert.deepEqual(sent(), ["10:opened"]);
});

test("a migrated v2 ledger adopts the current filters without seeding", async () => {
  writeFileSync(
    statePath(),
    JSON.stringify({
      version: 2,
      channels: { web: { "1:opened": { status: "delivered", at: 1 } } },
    }),
  );
  api.incidents = [incident({ id: 7, checkId: "db" })];
  const n = await start({ checks: ["api", "db"] });
  await poll(n);
  assert.equal(ledger().checkRouting("web"), '{"checks":["api","db"],"excludeChecks":[]}');
  // The documented once-only limit: history visible at the upgrade is sent.
  assert.deepEqual(sent(), ["7:opened"]);
  assert.deepEqual(changedLogs(), []);
});
