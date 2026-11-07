import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResendCommand } from "@lorenzh/pulse-contract";
import type { MailMessage, SendMail } from "../src/channels/mailer.ts";
import { Ledger, type LedgerOptions, type ResendCommandState } from "../src/ledger.ts";
import { Notifier } from "../src/notifier.ts";
import {
  type PostOutcome,
  pollResendCommands,
  type ResendCommandDeps,
} from "../src/resend-commands.ts";
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
const CMD1 = "AAAAAAAAAAAAAAAAAAAAAAA1";
const CMD2 = "AAAAAAAAAAAAAAAAAAAAAAA2";
const KEY = "1:opened";

let api: FakeApi;
let receivers: Receiver[];
let dir: string;
let logger: SpyLogger;
let open: Array<{ notifier: Notifier; ledger: Ledger }>;

beforeEach(async () => {
  api = await startFakeApi();
  receivers = [];
  dir = mkdtempSync(join(tmpdir(), "notify-resend-"));
  logger = spyLogger();
  open = [];
});
afterEach(async () => {
  for (const { notifier, ledger } of open) {
    await notifier.stop();
    ledger.close();
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

const noSleep: Sleep = () => Promise.resolve();

function webhook(id: string, url: string): ChannelConfig {
  return { id, type: "webhook", url } as ChannelConfig;
}

function start(
  channels: ChannelConfig[],
  extra: { sendMail?: SendMail; hooks?: LedgerOptions["hooks"] } = {},
): { notifier: Notifier; ledger: Ledger } {
  const ledger = new Ledger(join(dir, "state.sqlite"), {
    now: () => NOW,
    ...(extra.hooks ? { hooks: extra.hooks } : {}),
  });
  const notifier = new Notifier({
    config: { channels },
    apiUrl: api.url,
    ledger,
    logger,
    now: () => NOW,
    sleep: noSleep,
    retryAttempts: 1,
    schedule: () => () => {},
    ...(extra.sendMail ? { sendMail: extra.sendMail } : {}),
  });
  const running = { notifier, ledger };
  open.push(running);
  notifier.start();
  return running;
}

async function stopAll(): Promise<void> {
  for (const { notifier, ledger } of open.splice(0)) {
    await notifier.stop();
    ledger.close();
  }
}

/** Seeds, then opens incident 1 while every receiver is down, so the key ends `failed`. */
async function failIncident(notifier: Notifier): Promise<void> {
  await notifier.tick();
  api.incidents = [incident({ id: 1 })];
  await notifier.tick();
  await notifier.idle();
}

function command(id: string, channelId: string, key = KEY): ResendCommand {
  return {
    id,
    channelId,
    key,
    requestId: "request-0000000001",
    state: "claimed",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

interface FakeService {
  queue: ResendCommand[][];
  posts: Array<[string, ResendCommandState]>;
  answer: (id: string, state: ResendCommandState) => PostOutcome;
  isClaimDown: boolean;
}

function fakeService(): FakeService {
  return { queue: [], posts: [], answer: () => "acknowledged", isClaimDown: false };
}

function deps(
  service: FakeService,
  running: { notifier: Notifier; ledger: Ledger },
  enqueue?: (channelId: string, key: string) => void,
): ResendCommandDeps {
  return {
    ledger: running.ledger,
    logger,
    claim: () => {
      if (service.isClaimDown) return Promise.reject(new Error("claim failed: network"));
      return Promise.resolve(service.queue.shift() ?? []);
    },
    postResult: (id, state) => {
      service.posts.push([id, state]);
      return Promise.resolve(service.answer(id, state));
    },
    isInstalled: (id) => running.notifier.hasChannel(id),
    enqueue: enqueue ?? ((channelId, key) => running.notifier.enqueueResent(channelId, key)),
  };
}

test("a claimed command resends a failed key once, ends delivered and is never run again", async () => {
  const r = await receiver();
  r.up = false;
  const running = start([webhook("a", r.url)]);
  await failIncident(running.notifier);
  assert.equal(r.requests.length, 1);
  r.up = true;
  const service = fakeService();
  service.queue.push([command(CMD1, "a")]);
  await pollResendCommands(deps(service, running));
  await running.notifier.idle();
  assert.equal(r.requests.length, 2);
  assert.equal(r.requests[1]?.headers["idempotency-key"], KEY);
  assert.equal(r.requests[0]?.headers["idempotency-key"], KEY);
  assert.deepEqual(service.posts, [[CMD1, "admitted"]]);
  assert.equal(running.ledger.status("a", KEY), "delivered");
  await pollResendCommands(deps(service, running));
  assert.deepEqual(service.posts.at(-1), [CMD1, "delivered"]);
  // The api lost the answer and claims the command again: the stored state, no send.
  service.queue.push([command(CMD1, "a")]);
  await pollResendCommands(deps(service, running));
  await running.notifier.idle();
  assert.equal(r.requests.length, 2);
  assert.deepEqual(service.posts.at(-1), [CMD1, "delivered"]);
  // Also after a restart.
  await stopAll();
  const again = start([webhook("a", r.url)]);
  service.queue.push([command(CMD1, "a")]);
  await pollResendCommands(deps(service, again));
  await again.notifier.idle();
  assert.equal(r.requests.length, 2);
  assert.deepEqual(service.posts.at(-1), [CMD1, "delivered"]);
  assert.deepEqual(
    again.ledger.resendCommands().map((c) => [c.id, c.state, c.postedState]),
    [[CMD1, "delivered", "delivered"]],
  );
  assert.deepEqual(again.ledger.failed(), []);
});

test("a failed admission write rolls back: no command row and the key stays failed", async () => {
  const r = await receiver();
  r.up = false;
  let isBroken = false;
  const running = start([webhook("a", r.url)], {
    hooks: {
      beforeCommit: () => {
        if (isBroken) throw new Error("disk full");
      },
    },
  });
  await failIncident(running.notifier);
  isBroken = true;
  const service = fakeService();
  service.queue.push([command(CMD1, "a")]);
  await pollResendCommands(deps(service, running));
  assert.deepEqual(running.ledger.resendCommands(), []);
  assert.equal(running.ledger.status("a", KEY), "failed");
  assert.deepEqual(service.posts, []);
  assert.equal(r.requests.length, 1);
});

test("a crash after the admission commit and before the enqueue sends once at the next start", async () => {
  const r = await receiver();
  r.up = false;
  const running = start([webhook("a", r.url)]);
  await failIncident(running.notifier);
  r.up = true;
  const service = fakeService();
  service.queue.push([command(CMD1, "a")]);
  await pollResendCommands(deps(service, running, () => {}));
  assert.equal(r.requests.length, 1);
  await stopAll();
  const again = start([webhook("a", r.url)]);
  await again.notifier.idle();
  assert.equal(r.requests.length, 2);
  assert.equal(again.ledger.status("a", KEY), "delivered");
  assert.deepEqual(
    again.ledger.resendCommands().map((c) => [c.id, c.state]),
    [[CMD1, "delivered"]],
  );
});

test("admission outcomes: other channel untouched, not-failed, no-payload and channel-unavailable", async () => {
  const ra = await receiver();
  const rb = await receiver();
  ra.up = false;
  rb.up = false;
  const running = start([webhook("a", ra.url), webhook("b", rb.url)]);
  await failIncident(running.notifier);
  ra.up = true;
  const service = fakeService();
  service.queue.push([command(CMD1, "a")]);
  await pollResendCommands(deps(service, running));
  await running.notifier.idle();
  assert.equal(running.ledger.status("a", KEY), "delivered");
  assert.equal(running.ledger.status("b", KEY), "failed");
  assert.equal(rb.requests.length, 1);
  const cases: Array<[string, string, string, ResendCommandState]> = [
    ["AAAAAAAAAAAAAAAAAAAAAAA3", "a", KEY, "not-failed"],
    ["AAAAAAAAAAAAAAAAAAAAAAA4", "b", "9:opened", "not-failed"],
    ["AAAAAAAAAAAAAAAAAAAAAAA5", "gone", KEY, "channel-unavailable"],
  ];
  service.queue.push(cases.map(([id, channel, key]) => command(id, channel, key)));
  await pollResendCommands(deps(service, running));
  await running.notifier.idle();
  for (const [id, , , state] of cases) {
    assert.deepEqual(
      service.posts.find(([p]) => p === id),
      [id, state],
    );
  }
  assert.equal(rb.requests.length, 1);
  await running.notifier.reconcile([webhook("a", ra.url)]);
  service.queue.push([command(CMD2, "b")]);
  await pollResendCommands(deps(service, running));
  assert.deepEqual(service.posts.at(-1), [CMD2, "channel-unavailable"]);
  assert.equal(running.ledger.status("b", KEY), "failed");
});

test("a failed key without a stored payload ends no-payload", async () => {
  const path = join(dir, "state.sqlite");
  const seed = new Ledger(path, { now: () => NOW });
  seed.claim("a", KEY, {
    event: "opened",
    key: KEY,
  } as unknown as Parameters<Ledger["claim"]>[2]);
  seed.settle("a", KEY, "failed");
  seed.close();
  // Strip the payload as a legacy entry would have none.
  const { Database } = await import("bun:sqlite");
  const db = new Database(path);
  db.query("UPDATE entries SET payload = NULL").run();
  db.close();
  const r = await receiver();
  const running = start([webhook("a", r.url)]);
  const service = fakeService();
  service.queue.push([command(CMD1, "a")]);
  await pollResendCommands(deps(service, running));
  assert.deepEqual(service.posts, [[CMD1, "no-payload"]]);
  assert.equal(r.requests.length, 0);
});

test("result posts: 404 and 409 stop with one log line, a retry posts again, oldest first, at most 20", async () => {
  const r = await receiver();
  const running = start([webhook("a", r.url)]);
  const ids = Array.from({ length: 23 }, (_, i) => `CMD${String(i).padStart(21, "0")}`);
  const service = fakeService();
  service.queue.push(ids.slice(0, 20).map((id) => command(id, "gone")));
  service.queue.push(ids.slice(20).map((id) => command(id, "gone")));
  const refused: Record<string, PostOutcome> = {
    [ids[0] ?? ""]: "refused",
    [ids[1] ?? ""]: "refused",
    [ids[2] ?? ""]: "retry",
  };
  service.answer = (id) => refused[id] ?? "acknowledged";
  await pollResendCommands(deps(service, running));
  assert.equal(service.posts.length, 20);
  assert.deepEqual(
    service.posts.map(([id]) => id),
    ids.slice(0, 20),
  );
  assert.equal(
    logger.entries.filter((e) => e.msg === "resend result refused by the api").length,
    2,
  );
  service.answer = () => "acknowledged";
  service.posts = [];
  await pollResendCommands(deps(service, running));
  assert.deepEqual(
    service.posts.map(([id]) => id),
    [ids[2], ...ids.slice(20)],
  );
  service.posts = [];
  await pollResendCommands(deps(service, running));
  assert.deepEqual(service.posts, []);
  // A claim that fails still posts nothing twice and does not throw.
  service.isClaimDown = true;
  await pollResendCommands(deps(service, running));
  assert.deepEqual(service.posts, []);
});

test("a requeued command after a lost admission answer posts the stored state and sends nothing", async () => {
  const r = await receiver();
  r.up = false;
  const running = start([webhook("a", r.url)]);
  await failIncident(running.notifier);
  const service = fakeService();
  service.answer = () => "retry";
  service.queue.push([command(CMD1, "a")]);
  await pollResendCommands(deps(service, running, () => {}));
  assert.deepEqual(service.posts, [[CMD1, "admitted"]]);
  service.answer = () => "acknowledged";
  service.queue.push([command(CMD1, "a")]);
  await pollResendCommands(deps(service, running, () => {}));
  assert.deepEqual(service.posts, [
    [CMD1, "admitted"],
    [CMD1, "admitted"],
  ]);
  assert.equal(r.requests.length, 1);
  assert.deepEqual(
    running.ledger.resendCommands().map((c) => [c.state, c.postedState]),
    [["admitted", "admitted"]],
  );
});

test("a partly refused email resend retries only the refused recipients with the same Message-ID", async () => {
  const messages: MailMessage[] = [];
  let calls = 0;
  const sendMail: SendMail = (_smtp, message) => {
    messages.push(message);
    calls++;
    if (calls === 1) {
      return Promise.resolve({
        accepted: ["a@example.org"],
        refused: [{ recipient: "b@example.org", responseCode: 550 }],
      });
    }
    return Promise.resolve({ accepted: message.envelopeTo, refused: [] });
  };
  const email: ChannelConfig = {
    id: "mail",
    type: "email",
    smtp: { host: "127.0.0.1", port: 2525, tls: "none" },
    from: "notify@example.org",
    to: ["a@example.org", "b@example.org"],
  } as ChannelConfig;
  const running = start([email], { sendMail });
  await failIncident(running.notifier);
  assert.equal(running.ledger.status("mail", KEY), "failed");
  const service = fakeService();
  service.queue.push([command(CMD1, "mail")]);
  await pollResendCommands(deps(service, running));
  await running.notifier.idle();
  assert.deepEqual(
    messages.map((m) => m.envelopeTo),
    [["a@example.org", "b@example.org"], ["b@example.org"]],
  );
  assert.equal(messages[1]?.messageId, messages[0]?.messageId);
  assert.equal(running.ledger.status("mail", KEY), "delivered");
});
