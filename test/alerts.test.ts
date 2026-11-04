import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, type LedgerOptions } from "../src/ledger.ts";
import { Metrics } from "../src/metrics.ts";
import { Notifier } from "../src/notifier.ts";
import type { ChannelConfig } from "../src/types.ts";
import {
  asRecord,
  checkState,
  componentState,
  type FakeApi,
  httpCheck,
  incident,
  type Receiver,
  type SpyLogger,
  slo,
  spyLogger,
  startFakeApi,
  startReceiver,
  tlsCheck,
} from "./support.ts";

const byText = (a: string, b: string): number => a.localeCompare(b);
const HOUR_MS = 3_600_000;
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
/** SHA-256 of "api-1" and "site-tls", first 32 hex characters, computed with sha256sum. */
const API_1_HASH = "f9811b73ac5d1a8db842634fc0f871e0";
const SITE_TLS_HASH = "02fa6ac633dcbd84e3498d855c07e8bd";

let api: FakeApi;
let rx: Receiver;
let other: Receiver;
let dir: string;
let logger: SpyLogger;
let nowMs: number;
let ledgers: Ledger[];

beforeEach(async () => {
  api = await startFakeApi();
  rx = await startReceiver();
  other = await startReceiver();
  dir = mkdtempSync(join(tmpdir(), "notify-alerts-"));
  logger = spyLogger();
  nowMs = T0;
  ledgers = [];
});

afterEach(async () => {
  for (const ledger of ledgers) ledger.close();
  await api.close();
  await rx.close();
  await other.close();
  rmSync(dir, { recursive: true, force: true });
});

function channels(): ChannelConfig[] {
  return [
    { id: "a", type: "webhook", url: rx.url, alerts: ["budget-low", "tls-expiry", "tls-expiry"] },
    { id: "plain", type: "webhook", url: other.url },
  ];
}

function open(opts: LedgerOptions = {}): Ledger {
  const ledger = new Ledger(join(dir, "state.db"), { now: () => nowMs, ...opts });
  ledgers.push(ledger);
  return ledger;
}

function make(
  ledger: Ledger,
  over: {
    channels?: ChannelConfig[];
    metrics?: Metrics;
    sleep?: () => Promise<void>;
    stateRetentionDays?: number;
  } = {},
) {
  return new Notifier({
    config: { channels: over.channels ?? channels() },
    apiUrl: api.url,
    ledger,
    logger,
    now: () => nowMs,
    retryDelayMs: 1,
    sleep: over.sleep ?? (async () => {}),
    schedule: () => () => {},
    ...(over.metrics ? { metrics: over.metrics } : {}),
    ...(over.stateRetentionDays === undefined
      ? {}
      : { stateRetentionDays: over.stateRetentionDays }),
  });
}

async function poll(n: Notifier): Promise<void> {
  await n.tick();
  await n.idle();
}

function events(r: Receiver): string[] {
  return r.accepted().map((req) => String(asRecord(req.body).event));
}

function tls(days: number, observedMs: number) {
  return checkState(tlsCheck("site-tls", "Site TLS"), { certDaysLeft: days }, [observedMs]);
}

test("budget once per 24 hours", async () => {
  api.checks = [checkState(httpCheck("api-1", "API one"), { slo: slo(24) }, [T0]), tls(13, T0)];
  const n = make(open());
  await poll(n);
  assert.deepEqual(events(rx).sort(byText), ["budget-low", "tls-expiry"]);
  assert.deepEqual(events(other), []);
  const budget = rx.accepted().find((r) => asRecord(r.body).event === "budget-low");
  assert.ok(budget);
  const body = asRecord(budget.body);
  assert.equal(body.key, `budget:check:${T0}:${API_1_HASH}`);
  assert.equal(budget.headers["idempotency-key"], body.key);
  assert.deepEqual(body.budget, {
    remaining: 24,
    threshold: 25,
    target: 99.9,
    availability: 99.95,
    windowDays: 30,
  });

  nowMs = T0 + 24 * HOUR_MS - 1;
  await poll(n);
  assert.equal(events(rx).filter((e) => e === "budget-low").length, 1);

  nowMs = T0 + 24 * HOUR_MS;
  await poll(n);
  const keys = rx
    .accepted()
    .map((r) => asRecord(r.body))
    .filter((b) => b.event === "budget-low")
    .map((b) => b.key);
  assert.deepEqual(keys, [
    `budget:check:${T0}:${API_1_HASH}`,
    `budget:check:${T0 + 24 * HOUR_MS}:${API_1_HASH}`,
  ]);
  assert.deepEqual(events(other), []);
  await n.stop();
});

test("expiry milestones 14 and 3", async () => {
  api.checks = [tls(13, T0)];
  const n = make(open());
  await poll(n);
  nowMs = T0 + 60_000;
  api.checks = [tls(10, nowMs)];
  await poll(n);
  nowMs = T0 + 120_000;
  api.checks = [tls(3, nowMs)];
  await poll(n);
  nowMs = T0 + 180_000;
  api.checks = [tls(2, nowMs)];
  await poll(n);
  const bodies = rx.accepted().map((r) => asRecord(r.body));
  assert.deepEqual(
    bodies.map((b) => [b.key, b.expiry]),
    [
      [`expiry:${T0}:14:${SITE_TLS_HASH}`, { daysLeft: 13, milestone: 14, observedMs: T0 }],
      [`expiry:${T0}:3:${SITE_TLS_HASH}`, { daysLeft: 3, milestone: 3, observedMs: T0 + 120_000 }],
    ],
  );
  await n.stop();
});

test("expiry ordering survives restart", async () => {
  api.checks = [tls(13, T0 + 60_000)];
  nowMs = T0 + 60_000;
  const first = make(open());
  await poll(first);
  await first.stop();
  ledgers.pop()?.close();

  // An older reading than the one used before the restart is never used.
  nowMs = T0 + 120_000;
  api.checks = [tls(3, T0)];
  const second = make(open());
  await poll(second);
  assert.deepEqual(events(rx), ["tls-expiry"]);

  api.checks = [tls(3, nowMs)];
  await poll(second);
  const milestones = rx.accepted().map((r) => asRecord(asRecord(r.body).expiry).milestone);
  assert.deepEqual(milestones, [14, 3]);
  await second.stop();
});

test("two 500 answers then 204 give 3 attempts with one key", async () => {
  api.checks = [checkState(httpCheck("api-1", "API one"), { slo: slo(24) }, [T0])];
  let sleeps = 0;
  const n = make(open(), {
    channels: [{ id: "a", type: "webhook", url: rx.url, alerts: ["budget-low"] }],
    sleep: async () => {
      sleeps++;
      if (sleeps === 2) rx.status = 204;
    },
  });
  rx.status = 500;
  await poll(n);
  assert.deepEqual(
    rx.requests.map((r) => r.status),
    [500, 500, 204],
  );
  assert.equal(new Set(rx.requests.map((r) => r.headers["idempotency-key"])).size, 1);
  await n.stop();
});

test("a failed alert commit stores nothing and the next poll sends once", async () => {
  let isFailing = false;
  api.checks = [checkState(httpCheck("api-1", "API one"), { slo: slo(24) }, [T0])];
  const ledger = open({
    hooks: {
      beforeCommit: () => {
        if (isFailing) throw new Error("disk full");
      },
    },
  });
  const n = make(ledger, {
    channels: [{ id: "a", type: "webhook", url: rx.url, alerts: ["budget-low"] }],
  });
  api.checks = [];
  await poll(n); // seeds the channel
  api.checks = [checkState(httpCheck("api-1", "API one"), { slo: slo(24) }, [T0])];
  isFailing = true;
  await poll(n);
  assert.equal(rx.requests.length, 0);
  assert.equal(ledger.alertStates("budget-check").length, 0);
  assert.equal(ledger.pending().length, 0);
  assert.ok(
    logger.entries.some((e) => e.msg === "alert state write failed, the next poll retries"),
  );
  isFailing = false;
  await poll(n);
  assert.equal(rx.requests.length, 1);
  await n.stop();
});

test("a crash after the commit resends the same key and makes no new one", async () => {
  api.checks = [checkState(httpCheck("api-1", "API one"), { slo: slo(24) }, [T0])];
  // The first run posts to a separate receiver that is down, so a late request of the
  // stopped notifier can never reach the receiver that the second run is judged on.
  other.up = false;
  const first = make(open(), {
    channels: [{ id: "a", type: "webhook", url: other.url, alerts: ["budget-low"] }],
  });
  await first.tick();
  await first.stop();
  ledgers.pop()?.close();
  nowMs += 1000;
  const second = make(open(), {
    channels: [{ id: "a", type: "webhook", url: rx.url, alerts: ["budget-low"] }],
  });
  second.start();
  await second.idle();
  await poll(second);
  const keys = rx.accepted().map((r) => asRecord(r.body).key);
  assert.deepEqual(keys, [`budget:check:${T0}:${API_1_HASH}`]);
  await second.stop();
});

test("a subscriber not yet seeded holds back the kind; then both get the same key", async () => {
  const both: ChannelConfig[] = [
    { id: "a", type: "webhook", url: rx.url, alerts: ["budget-low"] },
    { id: "b", type: "webhook", url: other.url, alerts: ["budget-low"] },
  ];
  api.checks = [checkState(httpCheck("api-1", "API one"), { slo: slo(24) }, [T0])];
  api.incidents = [incident({ id: 5, checkId: "api-1" })];
  let failSeed = true;
  const ledger = open({
    hooks: {
      beforeCommit: () => {
        if (failSeed && !ledger.hasChannel("a")) return;
        if (failSeed) throw new Error("seed failed");
      },
    },
  });
  const n = make(ledger, { channels: both });
  await poll(n);
  // a seeded, b failed: no alert for anyone.
  assert.equal(ledger.hasChannel("a"), true);
  assert.equal(ledger.hasChannel("b"), false);
  assert.equal(ledger.alertStates("budget-check").length, 0);
  assert.equal(rx.requests.length + other.requests.length, 0);
  failSeed = false;
  await poll(n);
  const keyA = rx.accepted().map((r) => asRecord(r.body).key);
  const bodiesB = other.accepted().map((r) => asRecord(r.body));
  assert.deepEqual(keyA, [`budget:check:${T0}:${API_1_HASH}`]);
  assert.deepEqual(
    bodiesB.map((b) => b.key),
    keyA,
  );
  await n.stop();
});

test("component budgets use components, a 404 keeps check budgets", async () => {
  const metrics = new Metrics(["a"], () => 0);
  api.checks = [checkState(httpCheck("api-1", "API one"), { slo: slo(24) }, [T0])];
  const n = make(open(), {
    channels: [
      { id: "a", type: "webhook", url: rx.url, alerts: ["budget-low"], components: ["core"] },
    ],
    metrics,
  });
  await poll(n);
  assert.deepEqual(events(rx), ["budget-low"]);
  assert.equal(n.pollHealth().consecutiveFailedPolls, 0);
  api.components = [
    componentState("core", "Core", { slo: slo(10) }),
    componentState("edge", "Edge", { slo: slo(10) }),
    { id: 7 } as never,
  ];
  await poll(n);
  const subjects = rx.accepted().map((r) => asRecord(asRecord(r.body).subject).id);
  assert.deepEqual(subjects, ["api-1", "core"]);
  assert.match(metrics.render(), /pulse_notify_skipped_items_total\{feed="components"\} 1\n/);
  api.failingPaths.set("/components", 500);
  await poll(n);
  assert.equal(n.pollHealth().consecutiveFailedPolls, 1);
  assert.match(
    metrics.render(),
    /pulse_notify_feed_polls_total\{feed="components",outcome="error"\} 1\n/,
  );
  await n.stop();
});

test("no alerts means no components request and no second validation", async () => {
  const metrics = new Metrics(["plain"], () => 0);
  // A valid Check that is not a valid CheckWithState: no skip is counted without alerts.
  api.checks = [httpCheck("api-1", "API one")];
  const n = make(open(), {
    channels: [{ id: "plain", type: "webhook", url: other.url }],
    metrics,
  });
  await poll(n);
  assert.equal(api.requested.includes("/components"), false);
  assert.match(metrics.render(), /pulse_notify_skipped_items_total\{feed="checks"\} 0\n/);
  await n.stop();
});

test("a check failing the second validator keeps its name and is counted", async () => {
  const metrics = new Metrics(["a"], () => 0);
  api.checks = [httpCheck("api-1", "API one")];
  api.incidents = [];
  const n = make(open(), {
    channels: [{ id: "a", type: "webhook", url: rx.url, alerts: ["tls-expiry"] }],
    metrics,
  });
  await poll(n);
  api.incidents = [incident({ id: 3, checkId: "api-1" })];
  await poll(n);
  assert.equal(asRecord(rx.accepted()[0]?.body).checkName, "API one");
  assert.match(metrics.render(), /pulse_notify_skipped_items_total\{feed="checks"\} 2\n/);
  const logged = logger.entries.filter((e) => e.msg === "check skipped: malformed data");
  assert.deepEqual(
    logged.map((e) => e.fields),
    [{ feed: "checks", index: 0, reason: "invalid" }],
  );
  await n.stop();
});

test("an item still listed but invalid keeps its alert state through pruning", async () => {
  const DAY_MS = 24 * HOUR_MS;
  const sites = [
    {
      name: "check failing the second validator",
      kind: "expiry" as const,
      id: "site-tls",
      setValid: () => {
        api.checks = [tls(13, nowMs)];
      },
      // A valid Check without state: it fails only the CheckWithState validator.
      setInvalid: () => {
        api.checks = [tlsCheck("site-tls", "Site TLS")];
      },
    },
    {
      name: "component failing its validator",
      kind: "budget-component" as const,
      id: "core",
      setValid: () => {
        api.components = [componentState("core", "Core", { slo: slo(10) })];
      },
      setInvalid: () => {
        api.components = [{ id: "core", name: 7 } as never];
      },
    },
  ];
  for (const site of sites) {
    nowMs = T0;
    rmSync(join(dir, "state.db"), { force: true });
    api.checks = [];
    api.components = [];
    const ledger = open();
    const n = make(ledger, {
      channels: [{ id: "a", type: "webhook", url: rx.url, alerts: ["budget-low", "tls-expiry"] }],
      stateRetentionDays: 1,
    });
    site.setValid();
    await poll(n);
    assert.ok(ledger.alertState(site.kind, site.id), `${site.name}: row after the first poll`);
    nowMs = T0 + 2 * DAY_MS;
    site.setInvalid();
    await poll(n);
    assert.ok(ledger.alertState(site.kind, site.id), `${site.name}: row after the prune`);
    await n.stop();
    ledger.close();
    ledgers.pop();
  }
});
