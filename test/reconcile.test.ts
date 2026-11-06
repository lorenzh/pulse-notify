import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MailMessage, SendMail } from "../src/channels/mailer.ts";
import { Ledger } from "../src/ledger.ts";
import { Metrics } from "../src/metrics.ts";
import { Notifier } from "../src/notifier.ts";
import type { ChannelConfig, Sleep } from "../src/types.ts";
import {
  type FakeApi,
  incident,
  type Receiver,
  type SpyLogger,
  spyLogger,
  startFakeApi,
  startReceiver,
} from "./support.ts";

const NOW = Date.UTC(2026, 0, 1, 13, 0, 0);

let api: FakeApi;
let receivers: Receiver[];
let dir: string;
let logger: SpyLogger;
let running: { notifier: Notifier; ledger: Ledger } | undefined;

beforeEach(async () => {
  api = await startFakeApi();
  receivers = [];
  dir = mkdtempSync(join(tmpdir(), "notify-reconcile-"));
  logger = spyLogger();
  running = undefined;
});
afterEach(async () => {
  if (running) {
    await running.notifier.stop();
    running.ledger.close();
  }
  await api.close();
  for (const r of receivers) await r.close();
  rmSync(dir, { recursive: true, force: true });
});

async function receiver(): Promise<Receiver> {
  const r = await startReceiver();
  receivers.push(r);
  return r;
}

/** A retry wait that only ends when the worker aborts it, so a failed job stays waiting. */
const hangingSleep: Sleep = (_ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) resolve();
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });

function webhook(id: string, url: string, over: Partial<ChannelConfig> = {}): ChannelConfig {
  return { id, type: "webhook", url, ...over } as ChannelConfig;
}

function start(
  channels: ChannelConfig[],
  extra: { sendMail?: SendMail; fetch?: typeof fetch; metrics?: Metrics } = {},
): Notifier {
  const ledger = new Ledger(join(dir, "state.sqlite"), { now: () => NOW });
  const notifier = new Notifier({
    config: { channels },
    apiUrl: api.url,
    ledger,
    logger,
    now: () => NOW,
    sleep: hangingSleep,
    schedule: () => () => {},
    ...extra,
  });
  running = { notifier, ledger };
  notifier.start();
  return notifier;
}

/** Lets pending I/O (sends, handovers) run without waiting for a hanging retry. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
}

async function seedThenOpen(notifier: Notifier): Promise<void> {
  await notifier.tick();
  api.incidents = [incident({ id: 1 })];
  await notifier.tick();
  await settle();
}

test("a database-only start installs a webhook live, seeds old incidents and sends a new one once", async () => {
  const r = await receiver();
  api.incidents = [incident({ id: 1 })];
  const notifier = start([]);
  await notifier.tick();
  await notifier.reconcile([webhook("db", r.url)]);
  await notifier.tick();
  await notifier.idle();
  assert.equal(r.requests.length, 0);
  api.incidents = [incident({ id: 1 }), incident({ id: 2 })];
  await notifier.tick();
  await notifier.idle();
  assert.deepEqual(
    r.requests.map((q) => (q.body as { incidentId: number }).incidentId),
    [2],
  );
});

test("a pending retry goes to the new destination once and never again to the old one", async () => {
  const oldReceiver = await receiver();
  const newReceiver = await receiver();
  oldReceiver.up = false;
  const notifier = start([webhook("ops", oldReceiver.url)]);
  await seedThenOpen(notifier);
  assert.equal(oldReceiver.requests.length, 1);
  await notifier.reconcile([webhook("ops", newReceiver.url)]);
  await notifier.idle();
  assert.equal(newReceiver.requests.length, 1);
  assert.equal(oldReceiver.requests.length, 1);
  await notifier.tick();
  await notifier.idle();
  assert.equal(newReceiver.requests.length, 1);
});

test("a removed channel keeps its pending key unsent until it is added again", async () => {
  const r = await receiver();
  r.up = false;
  const channel = webhook("ops", r.url);
  const notifier = start([channel]);
  await seedThenOpen(notifier);
  assert.equal(r.requests.length, 1);
  r.up = true;
  await notifier.reconcile([]);
  await notifier.tick();
  await settle();
  assert.equal(r.requests.length, 1);
  assert.deepEqual(notifier.channels(), []);
  await notifier.reconcile([channel]);
  await notifier.idle();
  assert.equal(r.accepted().length, 1);
  await notifier.tick();
  await notifier.idle();
  assert.equal(r.accepted().length, 1);
});

test("an unchanged channel keeps its worker and a changed secret replaces it", async () => {
  const r = await receiver();
  const first = webhook("ops", r.url, { secret: "s1" });
  const notifier = start([first]);
  await notifier.reconcile([webhook("ops", r.url, { secret: "s1" })]);
  assert.equal(notifier.channels()[0], first);
  const changed = webhook("ops", r.url, { secret: "s2" });
  await notifier.reconcile([changed]);
  assert.equal(notifier.channels()[0], changed);
});

test("email recipient progress moves to the replacement worker", async () => {
  const envelopes: string[][] = [];
  let isFirst = true;
  const sendMail: SendMail = (_smtp, message: MailMessage) => {
    envelopes.push(message.envelopeTo);
    if (isFirst) {
      isFirst = false;
      return Promise.resolve({
        accepted: ["a@example.org"],
        refused: [{ recipient: "b@example.org", responseCode: 451 }],
      });
    }
    return Promise.resolve({ accepted: message.envelopeTo, refused: [] });
  };
  const email = (prefix: string): ChannelConfig => ({
    id: "mail",
    type: "email",
    smtp: { host: "127.0.0.1", port: 2525, tls: "none" },
    from: "notify@example.org",
    to: ["a@example.org", "b@example.org"],
    subjectPrefix: prefix,
  });
  const notifier = start([email("[one]")], { sendMail });
  await seedThenOpen(notifier);
  await notifier.reconcile([email("[two]")]);
  await notifier.idle();
  assert.deepEqual(envelopes, [["a@example.org", "b@example.org"], ["b@example.org"]]);
});

test("widening the routing live seeds the newly routed history quietly", async () => {
  const r = await receiver();
  api.incidents = [incident({ id: 1, checkId: "a" }), incident({ id: 2, checkId: "b" })];
  const notifier = start([webhook("ops", r.url, { checks: ["a"] })]);
  await notifier.tick();
  await notifier.reconcile([webhook("ops", r.url, { checks: ["a", "b"] })]);
  await notifier.tick();
  await notifier.idle();
  assert.equal(r.requests.length, 0);
  api.incidents.push(incident({ id: 3, checkId: "b" }), incident({ id: 4, checkId: "c" }));
  await notifier.tick();
  await notifier.idle();
  assert.deepEqual(
    r.requests.map((q) => (q.body as { incidentId: number }).incidentId),
    [3],
  );
});

test("a slow channel blocks neither its peer nor the poll", async () => {
  const fast = await receiver();
  const slowUrl = "http://127.0.0.1:9/slow";
  const realFetch = fetch;
  const routed = ((input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === slowUrl) {
      return new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    }
    return realFetch(input, init);
  }) as typeof fetch;
  const notifier = start([webhook("slow", slowUrl), webhook("fast", fast.url)], {
    fetch: routed,
  });
  await seedThenOpen(notifier);
  await notifier.reconcile([webhook("slow", slowUrl), webhook("fast", fast.url)]);
  await notifier.tick();
  await settle();
  assert.equal(fast.accepted().length, 1);
});

test("an installed channel has its metric series at once", async () => {
  const metrics = new Metrics([], () => 0);
  const notifier = start([], { metrics });
  assert.doesNotMatch(metrics.render(), /channel="db"/);
  await notifier.reconcile([webhook("db", "http://127.0.0.1:9/x")]);
  assert.match(
    metrics.render(),
    /pulse_notify_deliveries_total\{channel="db",outcome="success"\} 0/,
  );
});
