import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Ledger } from "../src/ledger.ts";
import { Notifier } from "../src/notifier.ts";
import type { ChannelConfig } from "../src/types.ts";
import { startSmtpStub } from "./smtp-stub.ts";
import {
  type FakeApi,
  httpCheck,
  incident,
  type Receiver,
  type SpyLogger,
  spyLogger,
  startFakeApi,
  startReceiver,
} from "./support.ts";

let api: FakeApi;
let rx: Receiver;
let dir: string;
let logger: SpyLogger;
let ledger: Ledger;
let sleeps: number[];

beforeEach(async () => {
  api = await startFakeApi();
  rx = await startReceiver();
  dir = mkdtempSync(join(tmpdir(), "notify-perm-"));
  logger = spyLogger();
  sleeps = [];
  api.checks = [httpCheck("example", "Example site")];
});

afterEach(async () => {
  await api.close();
  await rx.close();
  rmSync(dir, { recursive: true, force: true });
});

function make(channel: ChannelConfig, retryAttempts: number): Notifier {
  ledger = new Ledger(join(dir, "state.json"));
  return new Notifier({
    config: { channels: [channel] },
    apiUrl: api.url,
    ledger,
    logger,
    retryDelayMs: 1000,
    retryAttempts,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    schedule: () => () => {},
  });
}

async function openIncident(n: Notifier, id: number): Promise<void> {
  api.incidents = [...api.incidents, incident({ id })];
  await n.tick();
  await n.idle();
}

function failedLog() {
  return logger.entries.filter((e) => e.msg === "notification delivery failed");
}

const hook = (): ChannelConfig => ({ id: "hook", type: "webhook", url: rx.url });
const slack = (): ChannelConfig => ({ id: "chat", type: "slack", url: rx.url });

test("a 404 or 410 fails at once: one attempt, no sleep, logged as permanent", async () => {
  for (const [channel, status] of [
    [hook(), 404],
    [slack(), 404],
    [hook(), 410],
    [slack(), 410],
  ] as const) {
    rx.requests.length = 0;
    sleeps.length = 0;
    logger.entries.length = 0;
    api.incidents = [];
    rmSync(join(dir, "state.json"), { force: true });
    rx.status = status;
    const n = make(channel, 5);
    await n.tick();
    await openIncident(n, 1);
    assert.equal(rx.requests.length, 1, `${channel.type} ${status}`);
    assert.deepEqual(sleeps, []);
    const entry = failedLog()[0];
    assert.equal(entry?.fields.permanent, true);
    assert.match(JSON.stringify(entry?.fields), /permanent/);
    assert.equal(entry?.fields.attempts, 1);
    assert.equal(ledger.status(channel.id, "1:opened"), "failed");
  }
});

test("the next event of the channel is sent at once after a permanent error", async () => {
  const n = make(hook(), 5);
  await n.tick();
  rx.status = 404;
  await openIncident(n, 1);
  rx.status = 200;
  await openIncident(n, 2);
  assert.deepEqual(sleeps, []);
  assert.equal(rx.accepted().length, 1);
  assert.equal(ledger.status("hook", "2:opened"), "delivered");
  assert.equal(ledger.status("hook", "1:opened"), "failed");
});

test("a permanent error also ends the event when retries are unlimited (0)", async () => {
  const n = make(hook(), 0);
  await n.tick();
  rx.status = 404;
  await openIncident(n, 1);
  assert.equal(rx.requests.length, 1);
  assert.equal(ledger.status("hook", "1:opened"), "failed");
});

test("500, 408 and 429 are still retried up to the limit", async () => {
  for (const status of [500, 408, 429, 503]) {
    rx.requests.length = 0;
    sleeps.length = 0;
    api.incidents = [];
    rmSync(join(dir, "state.json"), { force: true });
    rx.status = status;
    const n = make(hook(), 3);
    await n.tick();
    await openIncident(n, 1);
    assert.equal(rx.requests.length, 3, String(status));
    assert.equal(sleeps.length, 2);
    assert.equal(failedLog().at(-1)?.fields.permanent, undefined);
  }
});

const email = (port: number): ChannelConfig => ({
  id: "mail",
  type: "email",
  smtp: { host: "127.0.0.1", port, tls: "none" },
  from: "pulse@example.com",
  to: ["ops@example.com"],
});

test("an SMTP 550 fails at once, a 451 is retried", async () => {
  const permanent = await startSmtpStub({ replies: { "RCPT TO": "550 no such user" } });
  try {
    const n = make(email(permanent.port), 5);
    await n.tick();
    await openIncident(n, 1);
    assert.deepEqual(sleeps, []);
    assert.equal(permanent.commands.filter((c) => c.startsWith("MAIL FROM")).length, 1);
    assert.equal(ledger.status("mail", "1:opened"), "failed");
    assert.equal(failedLog()[0]?.fields.permanent, true);
  } finally {
    await permanent.close();
  }

  api.incidents = [];
  rmSync(join(dir, "state.json"), { force: true });
  const transient = await startSmtpStub({ replies: { "RCPT TO": "451 try later" } });
  try {
    const n = make(email(transient.port), 5);
    await n.tick();
    await openIncident(n, 1);
    assert.equal(sleeps.length, 1);
    assert.equal(ledger.status("mail", "1:opened"), "delivered");
  } finally {
    await transient.close();
  }
});

test("the email EHLO name: channel key, then global setting, then the host name", async () => {
  const stub = await startSmtpStub();
  try {
    const cases: [string | undefined, string | undefined, string][] = [];
    cases.push([undefined, undefined, "EHLO web-1.example.com"]);
    cases.push([undefined, "global.example.com", "EHLO global.example.com"]);
    cases.push(["chan.example.com", "global.example.com", "EHLO chan.example.com"]);
    for (const [clientName, global, expected] of cases) {
      stub.commands.length = 0;
      api.incidents = [];
      rmSync(join(dir, "state.json"), { force: true });
      const base = email(stub.port);
      const channel: ChannelConfig =
        base.type === "email"
          ? { ...base, smtp: { ...base.smtp, ...(clientName ? { clientName } : {}) } }
          : base;
      ledger = new Ledger(join(dir, "state.json"));
      const n = new Notifier({
        config: { channels: [channel] },
        apiUrl: api.url,
        ledger,
        logger,
        retryDelayMs: 1,
        sleep: async () => {},
        schedule: () => () => {},
        smtpClientName: global,
        hostname: () => "web-1.example.com",
      });
      await n.tick();
      await openIncident(n, 1);
      assert.equal(stub.commands[0], expected);
    }
  } finally {
    await stub.close();
  }
});

test("an invalid host name falls back to localhost for EHLO", async () => {
  const stub = await startSmtpStub();
  try {
    ledger = new Ledger(join(dir, "state.json"));
    const n = new Notifier({
      config: { channels: [email(stub.port)] },
      apiUrl: api.url,
      ledger,
      logger,
      retryDelayMs: 1,
      sleep: async () => {},
      schedule: () => () => {},
      hostname: () => "___",
    });
    await n.tick();
    await openIncident(n, 1);
    assert.equal(stub.commands[0], "EHLO localhost");
  } finally {
    await stub.close();
  }
});
