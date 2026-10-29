import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { MailMessage, SendMail, SmtpOptions } from "../src/channels/mailer.ts";
import { Ledger } from "../src/ledger.ts";
import { Metrics } from "../src/metrics.ts";
import { Notifier } from "../src/notifier.ts";
import type { ChannelConfig } from "../src/types.ts";
import {
  asRecord,
  type FakeApi,
  httpCheck,
  incident,
  type Receiver,
  type SpyLogger,
  spyLogger,
  startFakeApi,
  startReceiver,
} from "./support.ts";

let current: Ledger | undefined;

function newLedger(): Ledger {
  current = new Ledger(join(dir, "state.json"));
  return current;
}

const SIGNING_KEY = "k".repeat(12);

let api: FakeApi;
let rx: Receiver;
let dir: string;
let logger: SpyLogger;
let mails: { smtp: SmtpOptions; message: MailMessage }[];
let failMail: Error | undefined;

beforeEach(async () => {
  api = await startFakeApi();
  rx = await startReceiver();
  dir = mkdtempSync(join(tmpdir(), "notify-ch-"));
  logger = spyLogger();
  mails = [];
  failMail = undefined;
  mailCalls = 0;
  mailHook = undefined;
  api.checks = [httpCheck("example", "Example site"), httpCheck("other", "Other")];
});

afterEach(async () => {
  await api.close();
  await rx.close();
  rmSync(dir, { recursive: true, force: true });
});

let mailHook: (() => void) | undefined;
let mailCalls = 0;

const sendMail: SendMail = async (smtp, message) => {
  mailCalls++;
  mailHook?.();
  if (failMail) throw failMail;
  mails.push({ smtp, message });
};

function make(channels: ChannelConfig[], retryAttempts = 3, metrics?: Metrics): Notifier {
  return new Notifier({
    config: { channels },
    apiUrl: api.url,
    ledger: newLedger(),
    logger,
    retryDelayMs: 1,
    retryAttempts,
    sleep: async () => {},
    schedule: () => () => {},
    sendMail,
    now: () => Date.UTC(2026, 0, 1, 12, 0, 30),
    ...(metrics ? { metrics } : {}),
  });
}

async function openIncident(n: Notifier, over = {}): Promise<void> {
  await n.tick(); // seeds
  api.incidents = [incident({ id: 1, ...over })];
  await n.tick();
  await n.idle();
}

test("slack gets a text payload, escaped, and honors hideReason and statusUrl", async () => {
  const n = make([
    {
      id: "s",
      type: "slack",
      url: rx.url,
      statusUrl: "https://status.example.com",
    },
    { id: "s2", type: "slack", url: rx.url, hideReason: true },
  ]);
  await openIncident(n, { reason: "<!channel> & boom\nline" });
  const texts = rx.accepted().map((r) => String(asRecord(r.body).text));
  assert.equal(texts.length, 2);
  assert.ok(texts[0]?.includes("*DOWN*: Example site"));
  assert.ok(texts[0]?.includes("Reason: &lt;!channel&gt; &amp; boom line"));
  assert.ok(texts[0]?.includes("Status: https://status.example.com"));
  assert.ok(!texts[1]?.includes("Reason"));
  assert.ok(!texts[1]?.includes("Status"));
});

test("teams gets a message with an adaptive card; 202 is success", async () => {
  rx.status = 202;
  const n = make([{ id: "t", type: "teams", url: rx.url }]);
  await openIncident(n);
  assert.equal(rx.requests.length, 1);
  const body = asRecord(rx.requests[0]?.body);
  assert.equal(body.type, "message");
  assert.match(JSON.stringify(body), /application\/vnd\.microsoft\.card\.adaptive/);
  assert.equal(logger.entries.filter((e) => e.msg === "notification delivered").length, 1);
});

test("HTTP 500 and 429 are retried until delivered; redirects fail", async () => {
  const statuses = [500, 429, 200];
  let calls = 0;
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith(api.url)) return fetch(input, init);
    const status = statuses[calls++] ?? 200;
    return new Response(null, { status });
  };
  const n = new Notifier({
    config: {
      channels: [{ id: "s", type: "slack", url: "https://hooks.example.test/T/secret-path" }],
    },
    apiUrl: api.url,
    ledger: newLedger(),
    logger,
    retryDelayMs: 1,
    retryAttempts: 5,
    sleep: async () => {},
    schedule: () => () => {},
    fetch: fetchFn,
  });
  await openIncident(n);
  assert.equal(calls, 3);
  assert.equal(logger.entries.filter((e) => e.msg === "notification delivered").length, 1);
  assert.equal(JSON.stringify(logger.entries).includes("secret-path"), false);
});

test("a redirect from slack is a failure", async () => {
  rx.status = 302;
  const n = make([{ id: "s", type: "slack", url: rx.url }], 2);
  await openIncident(n);
  const failure = logger.entries.find((e) => e.msg === "notification delivery failed");
  assert.equal(failure?.fields.error, "slack responded with status 302");
});

test("a network error does not leak the URL into the log", async () => {
  const dead = await startReceiver();
  const url = `${dead.url}/services/TOKEN-123456`;
  await dead.close();
  const n = make([{ id: "s", type: "slack", url }], 2);
  await openIncident(n);
  const failure = logger.entries.find((e) => e.msg === "notification delivery failed");
  assert.equal(failure?.fields.error, "slack request failed");
  assert.equal(JSON.stringify(logger.entries).includes("TOKEN-123456"), false);
});

test("a signed webhook carries a MAC over the raw body and a timestamp", async () => {
  const n = make([{ id: "w", type: "webhook", url: rx.url, secret: SIGNING_KEY }]);
  await openIncident(n);
  const req = rx.accepted()[0];
  assert.ok(req);
  const digest = createHmac("sha256", SIGNING_KEY).update(req.raw).digest("hex");
  const expected = ["sha256", digest].join("=");
  assert.equal(req.headers["x-pulse-signature"], expected);
  assert.equal(req.headers["x-pulse-timestamp"], String(Date.UTC(2026, 0, 1, 12, 0, 30) / 1000));
  assert.equal(req.headers["idempotency-key"], "1:opened");
});

test("a webhook without a secret sends neither signature header", async () => {
  const n = make([{ id: "w", type: "webhook", url: rx.url }]);
  await openIncident(n);
  const headers = rx.accepted()[0]?.headers ?? {};
  assert.equal("x-pulse-signature" in headers, false);
  assert.equal("x-pulse-timestamp" in headers, false);
});

test("a webhook over http to a remote host warns once, naming only the channel", async () => {
  make([{ id: "w", type: "webhook", url: "http://hooks.example.com/token-abc" }]);
  const warnings = logger.entries.filter((e) => e.level === "warn");
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0]?.fields, { channel: "w" });
  make([{ id: "local", type: "webhook", url: rx.url }]);
  assert.equal(logger.entries.filter((e) => e.level === "warn").length, 1);
});

test("email goes through the SMTP client with a stable Message-ID and a safe subject", async () => {
  const n = make([
    {
      id: "m",
      type: "email",
      smtp: { host: "127.0.0.1", port: 2525, tls: "none" },
      from: "Pulse <pulse@example.com>",
      to: ["ops@example.com"],
      subjectPrefix: "[pulse]",
    },
  ]);
  await openIncident(n, { reason: "bad\r\nBcc: evil@example.com" });
  assert.equal(mails.length, 1);
  const mail = mails[0];
  assert.deepEqual(mail?.message.to, ["ops@example.com"]);
  assert.equal(mail?.message.from, "Pulse <pulse@example.com>");
  assert.equal(mail?.message.subject, "[pulse] DOWN: Example site");
  assert.match(mail?.message.messageId ?? "", /^<[0-9a-f]{32}@example\.com>$/);
  assert.equal(mail?.message.date.getTime(), Date.UTC(2026, 0, 1, 12, 0, 30));
  const text = mail?.message.text ?? "";
  assert.ok(text.includes("Reason: bad  Bcc: evil@example.com"));
  assert.ok(text.includes("State: DOWN"));
});

test("an SMTP failure is retried until it works, then delivered", async () => {
  const n = make(
    [
      {
        id: "m",
        type: "email",
        smtp: { host: "127.0.0.1", port: 2525, tls: "none" },
        from: "pulse@example.com",
        to: ["ops@example.com"],
      },
    ],
    3,
  );
  let calls = 0;
  failMail = new Error("SMTP RCPT TO failed: 451 later");
  mailHook = () => {
    calls++;
    if (calls === 2) failMail = undefined;
  };
  await openIncident(n);
  assert.equal(calls, 2);
  assert.equal(mails.length, 1);
  assert.equal(logger.entries.filter((e) => e.msg === "notification delivered").length, 1);
});

test("an SMTP error that never clears ends as failed", async () => {
  const n = make(
    [
      {
        id: "m",
        type: "email",
        smtp: { host: "127.0.0.1", port: 2525, tls: "none" },
        from: "pulse@example.com",
        to: ["ops@example.com"],
      },
    ],
    2,
  );
  failMail = new Error("SMTP RCPT TO failed: 550 no");
  await openIncident(n);
  assert.ok(mailCalls > 0);
  assert.ok(logger.entries.some((e) => e.msg === "notification delivery failed"));
  await current?.flush();
  const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  assert.equal(state.channels.m["1:opened"].status, "failed");
});

test("routing: checks pattern and excludeChecks apply to every channel type", async () => {
  api.incidents = [];
  const n = make([
    { id: "a", type: "webhook", url: rx.url, checks: ["ex*"], excludeChecks: ["example"] },
    { id: "b", type: "slack", url: rx.url, checks: ["ex*"] },
  ]);
  await n.tick();
  api.incidents = [incident({ id: 1, checkId: "example" }), incident({ id: 2, checkId: "other" })];
  await n.tick();
  await n.idle();
  assert.equal(rx.accepted().length, 1);
  assert.ok(String(asRecord(rx.accepted()[0]?.body).text).includes("Example site"));
});

test("no secret, URL or password appears in logs or metrics", async () => {
  const secrets = ["SECRET-HMAC-1", "TOKEN-URL-2", "PASSWORD-3"];
  const metrics = new Metrics(["w", "s", "m"], () => 0);
  const n = make(
    [
      { id: "w", type: "webhook", url: `${rx.url}/hook`, secret: secrets[0] ?? "" },
      { id: "s", type: "slack", url: `${rx.url}/${secrets[1]}` },
      {
        id: "m",
        type: "email",
        smtp: {
          host: "127.0.0.1",
          port: 2525,
          tls: "none",
          username: "u",
          password: secrets[2] ?? "",
        },
        from: "pulse@example.com",
        to: ["ops@example.com"],
      },
    ],
    2,
    metrics,
  );
  failMail = new Error("SMTP boom");
  await openIncident(n);
  const dump = JSON.stringify(logger.entries) + metrics.render();
  assert.ok(mailCalls > 0);
  assert.ok(logger.entries.some((e) => e.msg === "notification delivery failed"));
  await current?.flush();
  const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  assert.equal(state.channels.m["1:opened"].status, "failed");
  for (const secret of secrets) assert.equal(dump.includes(secret), false, secret);
});
