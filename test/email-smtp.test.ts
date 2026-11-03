import { afterAll, beforeAll, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmailSender } from "../src/channels/email.ts";
import {
  ehloNameFrom,
  isEhloName,
  type MailMessage,
  recipientId,
  type SendMail,
  type SendMailResult,
  type SmtpOptions,
} from "../src/channels/mailer.ts";
import { SmtpError, sendMail } from "../src/channels/smtp-send.ts";
import { ChannelDelivery } from "../src/delivery.ts";
import { errorFields, PartialDeliveryError, PermanentDeliveryError } from "../src/errors.ts";
import { Ledger, type LedgerOptions } from "../src/ledger.ts";
import type { Notification, RecipientProgress } from "../src/types.ts";
import { decodeHeader, decodeMail } from "./mail-decode.ts";
import {
  makeCert,
  type SmtpStub,
  startSmtpStub,
  startTlsSmtpStub,
  type TestCert,
} from "./smtp-stub.ts";
import { spyLogger } from "./support.ts";

let cert: TestCert;
beforeAll(() => {
  cert = makeCert();
});

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const message: MailMessage = {
  from: "pulse@example.com",
  to: ["a@example.com", "b@example.com"],
  envelopeTo: ["a@example.com", "b@example.com"],
  subject: "hi",
  text: ".dot line\nplain\n",
  date: new Date(Date.UTC(2026, 0, 1, 12, 0, 0)),
  messageId: "<abc@example.com>",
};
/** One recipient, so a refused RCPT leaves nobody to deliver to. */
const single: MailMessage = { ...message, to: ["a@example.com"], envelopeTo: ["a@example.com"] };

function options(port: number, over: Partial<SmtpOptions> = {}): SmtpOptions {
  return {
    host: "127.0.0.1",
    port,
    tls: "none",
    timeoutMs: 1000,
    schedule: () => () => {},
    ...over,
  };
}

test("sends the full conversation to every recipient and the content decodes", async () => {
  const stub = await startSmtpStub();
  try {
    await sendMail(options(stub.port), message);
    const verbs = stub.commands.map((c) => c.split(/[ :]/)[0]);
    assert.deepEqual(verbs.slice(0, 5), ["EHLO", "MAIL", "RCPT", "RCPT", "DATA"]);
    assert.equal(stub.commands[0], "EHLO localhost");
    assert.ok(stub.commands[1]?.startsWith("MAIL FROM:<pulse@example.com>"));
    assert.equal(stub.commands[2], "RCPT TO:<a@example.com>");
    assert.equal(stub.commands[3], "RCPT TO:<b@example.com>");
    const mail = decodeMail(stub.messages[0] ?? "");
    assert.equal(mail.headers.subject, "hi");
    assert.equal(mail.headers["message-id"], "<abc@example.com>");
    // The stub does not undo dot-stuffing, so the leading dot is doubled on the wire.
    assert.equal(mail.body.trim(), "..dot line\nplain");
  } finally {
    await stub.close();
  }
});

test("a non-ASCII subject is encoded and decodes to the original", async () => {
  const stub = await startSmtpStub();
  const subject = "[Prüfung 日本] DOWN: Prüfung 日本";
  try {
    await sendMail(options(stub.port), { ...message, subject, text: "Prüfung 日本\n" });
    const mail = decodeMail(stub.messages[0] ?? "");
    assert.match(mail.headers.subject ?? "", /^[ -~]*$/);
    assert.equal(decodeHeader(mail.headers.subject ?? ""), subject);
    assert.equal(mail.body.trim(), "Prüfung 日本");
  } finally {
    await stub.close();
  }
});

test("AUTH PLAIN sends the credentials in one command", async () => {
  const stub = await startSmtpStub({ auth: ["PLAIN", "LOGIN"] });
  try {
    await sendMail(options(stub.port, { username: "u", password: "p" }), message);
    const expected = Buffer.from("\0u\0p").toString("base64");
    assert.ok(stub.commands.includes(`AUTH PLAIN ${expected}`));
    assert.equal(
      stub.commands.some((c) => c.startsWith("AUTH LOGIN")),
      false,
    );
  } finally {
    await stub.close();
  }
});

test("AUTH LOGIN is used when PLAIN is not offered", async () => {
  const stub = await startSmtpStub({ auth: ["LOGIN"] });
  try {
    await sendMail(options(stub.port, { username: "u", password: "p" }), message);
    assert.ok(stub.commands.includes("AUTH LOGIN"));
    assert.equal(stub.messages.length, 1);
  } finally {
    await stub.close();
  }
});

test("no AUTH mechanism in common rejects and never uses CRAM-MD5", async () => {
  const stub = await startSmtpStub({ auth: ["CRAM-MD5"] });
  try {
    await assert.rejects(
      sendMail(options(stub.port, { username: "u", password: "p" }), message),
      /no supported AUTH/,
    );
    assert.equal(
      stub.commands.some((c) => c.startsWith("AUTH")),
      false,
    );
    assert.equal(stub.messages.length, 0);
  } finally {
    await stub.close();
  }
});

test("AUTH over tls none to a remote host is refused before connecting", async () => {
  await assert.rejects(
    sendMail(options(1, { host: "mail.example.com", username: "u", password: "p" }), message),
    /unencrypted/,
  );
});

test("STARTTLS upgrades with certificate verification", async () => {
  const stub = await startSmtpStub({ starttls: cert, auth: ["PLAIN"] });
  try {
    await sendMail(
      options(stub.port, {
        tls: "starttls",
        username: "u",
        password: "p",
        tlsOptions: { ca: cert.cert },
      }),
      message,
    );
    assert.equal(stub.commands.filter((c) => c.startsWith("EHLO")).length, 2);
    assert.ok(stub.commands.includes("STARTTLS"));
    assert.equal(stub.messages.length, 1);
  } finally {
    await stub.close();
  }
});

test("STARTTLS fails when the certificate is not trusted", async () => {
  const stub = await startSmtpStub({ starttls: cert });
  try {
    await assert.rejects(sendMail(options(stub.port, { tls: "starttls" }), message));
    assert.equal(stub.messages.length, 0);
  } finally {
    await stub.close();
  }
});

test("STARTTLS is required when the server does not offer it", async () => {
  const stub = await startSmtpStub();
  try {
    await assert.rejects(sendMail(options(stub.port, { tls: "starttls" }), message));
    assert.equal(stub.messages.length, 0);
  } finally {
    await stub.close();
  }
});

test("implicit TLS delivers a message", async () => {
  const stub = await startTlsSmtpStub(cert);
  try {
    await sendMail(options(stub.port, { tls: "tls", tlsOptions: { ca: cert.cert } }), message);
    assert.equal(stub.messages.length, 1);
  } finally {
    await stub.close();
  }
});

test("a recipient refused at RCPT is reported in the result while the others get the message", async () => {
  for (const code of [451, 550]) {
    const stub = await startSmtpStub({ replies: { "RCPT TO:<a@": `${code} nope` } });
    try {
      const result = await sendMail(options(stub.port), message);
      assert.deepEqual(result, {
        accepted: ["b@example.com"],
        refused: [{ recipient: "a@example.com", responseCode: code }],
      });
      assert.equal(stub.messages.length, 1);
    } finally {
      await stub.close();
    }
  }
});

test("only the envelope recipients get RCPT TO; the To header keeps every recipient", async () => {
  const stub = await startSmtpStub();
  try {
    const result = await sendMail(options(stub.port), {
      ...message,
      envelopeTo: ["b@example.com"],
    });
    assert.deepEqual(result, { accepted: ["b@example.com"], refused: [] });
    assert.deepEqual(
      stub.commands.filter((c) => c.startsWith("RCPT")),
      ["RCPT TO:<b@example.com>"],
    );
    const mail = decodeMail(stub.messages[0] ?? "");
    assert.equal(mail.headers.to, "a@example.com, b@example.com");
  } finally {
    await stub.close();
  }
});

test("a silent server hits the timeout", async () => {
  const stub = await startSmtpStub({ isSilent: true });
  const timers: (() => void)[] = [];
  try {
    const sending = sendMail(
      options(stub.port, {
        schedule: (fn) => {
          timers.push(fn);
          return () => {};
        },
      }),
      message,
    );
    timers[0]?.();
    await assert.rejects(sending, /timed out/);
  } finally {
    await stub.close();
  }
});

test("an abort signal stops the send", async () => {
  const stub = await startSmtpStub({ isSilent: true });
  const controller = new AbortController();
  try {
    const sending = sendMail(options(stub.port, { signal: controller.signal }), message);
    controller.abort();
    await assert.rejects(sending, /aborted/);
  } finally {
    await stub.close();
  }
});

test("a refused connection rejects", async () => {
  const stub = await startSmtpStub();
  const { port } = stub;
  await stub.close();
  await assert.rejects(sendMail(options(port), message));
});

test("a line break in the subject is rejected", async () => {
  await assert.rejects(
    sendMail(options(1), { ...message, subject: "a\r\nBcc: x@y" }),
    /line break/,
  );
});

test("a line break in an address is rejected", async () => {
  const bad = ["a@example.com\r\nRCPT TO:<x@y>"];
  for (const over of [{ to: bad }, { envelopeTo: bad }]) {
    await assert.rejects(sendMail(options(1), { ...message, ...over }), /line break/);
  }
});

test("an AUTH failure reports the code only, not the reply text", async () => {
  const credentials = Buffer.from("\0user\0pw", "utf8").toString("base64");
  const stub = await startSmtpStub({
    auth: ["PLAIN"],
    replies: { "AUTH PLAIN": `535 bad ${credentials}\r\n` },
  });
  try {
    await assert.rejects(
      sendMail(options(stub.port, { username: "user", password: "pw" }), message),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, "SMTP AUTH failed: 535");
        return true;
      },
    );
  } finally {
    await stub.close();
  }
});

test("a reply injected before the STARTTLS handshake is discarded, not read after it", async () => {
  // Nodemailer drops plaintext buffered with the "220" (RFC 3207). Had it kept this reply, it
  // would answer the second EHLO, and an EHLO 5xx fails the attempt as permanent.
  const stub = await startSmtpStub({
    starttls: cert,
    auth: ["PLAIN"],
    injectAfterStartTls: "550 injected\r\n",
  });
  try {
    await sendMail(
      options(stub.port, {
        tls: "starttls",
        tlsOptions: { ca: cert.cert },
        username: "u",
        password: "p",
      }),
      message,
    );
    const afterTls = stub.commands.slice(stub.commands.indexOf("STARTTLS") + 1);
    const verbs = afterTls.map((c) => c.split(/[ :]/)[0]);
    assert.deepEqual(verbs.slice(0, 6), ["EHLO", "AUTH", "MAIL", "RCPT", "RCPT", "DATA"]);
    assert.equal(stub.messages.length, 1);
  } finally {
    await stub.close();
  }
});

const SECRET = "review-only-password";
const ECHO = "ECHOED-BY-SERVER";

/** Every error in the cause chain with all its own fields, as JSON. */
function chainJson(err: unknown): string {
  const parts: unknown[] = [];
  for (let current = err; current instanceof Error; current = current.cause) {
    const fields: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(current)) fields[key] = Reflect.get(current, key);
    parts.push(fields);
  }
  return JSON.stringify(parts);
}

test("no server text reaches the error chain or its log fields", async () => {
  const echo = `${ECHO} password=${SECRET}`;
  const cases: Record<string, string>[] = [
    { "AUTH PLAIN": `535 ${echo}` },
    { EHLO: `550 ${echo}` },
    { EHLO: `451 ${echo}` },
    { "MAIL FROM": `550 ${echo}` },
    { DATA: `554 ${echo}` },
  ];
  for (const replies of cases) {
    const stub = await startSmtpStub({ auth: ["PLAIN"], replies });
    try {
      const login = { username: "user", password: SECRET };
      await assert.rejects(sendMail(options(stub.port, login), single), (err: unknown) => {
        const text = chainJson(err) + JSON.stringify(errorFields(err));
        const stage = Object.keys(replies).join();
        assert.equal(text.includes(SECRET), false, `${stage}: ${text}`);
        assert.equal(text.includes(ECHO), false, `${stage}: ${text}`);
        return true;
      });
      assert.equal(stub.messages.length, 0);
    } finally {
      await stub.close();
    }
  }
  // A refusal at RCPT is a result: it carries the address and the numeric code only.
  const stub = await startSmtpStub({ replies: { "RCPT TO": `550 ${echo}` } });
  try {
    const result = await sendMail(options(stub.port), single);
    assert.deepEqual(result, {
      accepted: [],
      refused: [{ recipient: "a@example.com", responseCode: 550 }],
    });
  } finally {
    await stub.close();
  }
});

/** Lets the event loop run until the stub saw `prefix`. */
async function untilCommand(stub: { commands: string[] }, prefix: string): Promise<void> {
  while (!stub.commands.some((c) => c.startsWith(prefix))) {
    await new Promise((r) => setImmediate(r));
  }
}

/** True once the stub saw the connection close, within a bounded number of loop turns. */
async function isClosedSoon(closed: Promise<void>): Promise<boolean> {
  let isClosed = false;
  void closed.then(() => {
    isClosed = true;
  });
  for (let turn = 0; turn < 500 && !isClosed; turn++) {
    await new Promise((r) => setImmediate(r));
  }
  return isClosed;
}

test("an abort closes the connection to the server", async () => {
  const stub = await startSmtpStub({ silentOn: ["MAIL FROM"] });
  const controller = new AbortController();
  try {
    const sending = sendMail(
      options(stub.port, { signal: controller.signal, timeoutMs: 60_000 }),
      message,
    );
    await untilCommand(stub, "MAIL FROM");
    controller.abort();
    await assert.rejects(sending, /aborted/);
    assert.equal(await isClosedSoon(stub.firstClosed), true);
  } finally {
    await stub.close();
  }
});

test("a timeout closes the connection to the server", async () => {
  const stub = await startSmtpStub({ silentOn: ["MAIL FROM"] });
  const timers: (() => void)[] = [];
  try {
    const schedule = (fn: () => void): (() => void) => {
      timers.push(fn);
      return () => {};
    };
    const sending = sendMail(options(stub.port, { schedule, timeoutMs: 60_000 }), message);
    await untilCommand(stub, "MAIL FROM");
    timers[0]?.();
    await assert.rejects(sending, /timed out/);
    assert.equal(await isClosedSoon(stub.firstClosed), true);
  } finally {
    await stub.close();
  }
});

test("a 5xx reply is a permanent error at every stage but RCPT, a 4xx is not", async () => {
  for (const verb of ["EHLO", "MAIL FROM", "DATA"]) {
    for (const code of [550, 451]) {
      const stub = await startSmtpStub({ replies: { [verb]: `${code} nope` } });
      try {
        await assert.rejects(sendMail(options(stub.port), single), (err: unknown) => {
          assert.equal(err instanceof PermanentDeliveryError, code === 550, `${verb} ${code}`);
          return true;
        });
        assert.equal(stub.messages.length, 0, `${verb} ${code}`);
      } finally {
        await stub.close();
      }
    }
  }
});

test("all recipients refused: with a 5xx a result, with only 4xx today's retryable error", async () => {
  const hard = await startSmtpStub({
    replies: { "RCPT TO:<a@": "550 no", "RCPT TO:<b@": "451 later" },
  });
  try {
    const result = await sendMail(options(hard.port), message);
    assert.deepEqual(result, {
      accepted: [],
      refused: [
        { recipient: "a@example.com", responseCode: 550 },
        { recipient: "b@example.com", responseCode: 451 },
      ],
    });
    assert.equal(hard.messages.length, 0);
  } finally {
    await hard.close();
  }
  const soft = await startSmtpStub({
    replies: { "RCPT TO:<a@": "451 no", "RCPT TO:<b@": "452 later" },
  });
  try {
    await assert.rejects(sendMail(options(soft.port), message), (err: unknown) => {
      assert.equal(err instanceof SmtpError, true);
      assert.equal((err as Error).message, "SMTP rejected the message: 451");
      return true;
    });
  } finally {
    await soft.close();
  }
});

test("an EHLO 5xx is permanent with STARTTLS and implicit TLS, not answered with HELO", async () => {
  const starttls = await startSmtpStub({ starttls: cert, replies: { EHLO: "550 nope" } });
  try {
    const over = { tls: "starttls" as const, tlsOptions: { ca: cert.cert } };
    await assert.rejects(sendMail(options(starttls.port, over), message), PermanentDeliveryError);
    assert.equal(starttls.messages.length, 0);
  } finally {
    await starttls.close();
  }
  const tls = await startTlsSmtpStub(cert, { replies: { EHLO: "550 nope" } });
  try {
    const over = { tls: "tls" as const, tlsOptions: { ca: cert.cert } };
    await assert.rejects(sendMail(options(tls.port, over), message), PermanentDeliveryError);
    assert.equal(tls.messages.length, 0);
    assert.equal(
      tls.commands.some((c) => c.startsWith("HELO")),
      false,
    );
  } finally {
    await tls.close();
  }
});

test("a 5xx greeting and a 5xx end-of-data reply are permanent", async () => {
  const stub = await startSmtpStub({ greeting: "554 no service" });
  try {
    await assert.rejects(sendMail(options(stub.port), message), PermanentDeliveryError);
  } finally {
    await stub.close();
  }

  const end = await startSmtpStub({ endOfDataReply: "552 too big" });
  try {
    await assert.rejects(sendMail(options(end.port), message), PermanentDeliveryError);
  } finally {
    await end.close();
  }
});

test("the EHLO name is sent as given", async () => {
  const stub = await startSmtpStub();
  try {
    await sendMail(options(stub.port, { clientName: "pulse.example.com" }), message);
    assert.equal(stub.commands[0], "EHLO pulse.example.com");
  } finally {
    await stub.close();
  }
});

test("one timer covers the whole attempt, not each command", async () => {
  const stub = await startSmtpStub();
  const scheduled: number[] = [];
  try {
    await sendMail(
      options(stub.port, {
        timeoutMs: 777,
        schedule: (_fn, ms) => {
          scheduled.push(ms);
          return () => {};
        },
      }),
      message,
    );
    assert.deepEqual(scheduled, [777]);
  } finally {
    await stub.close();
  }
});

test("the attempt timer firing mid-conversation is a retryable timeout", async () => {
  const stub = await startSmtpStub({ silentOn: ["MAIL FROM"] });
  const timers: (() => void)[] = [];
  try {
    const sending = sendMail(
      options(stub.port, {
        schedule: (fn) => {
          timers.push(fn);
          return () => {};
        },
      }),
      message,
    );
    // Wait until the stub saw MAIL FROM: EHLO was answered, so the timer is still the same one.
    while (!stub.commands.some((c) => c.startsWith("MAIL FROM:"))) {
      await new Promise((r) => setImmediate(r));
    }
    timers[0]?.();
    await assert.rejects(sending, (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /timed out/);
      assert.equal(err instanceof PermanentDeliveryError, false);
      return true;
    });
    assert.equal(timers.length, 1);
  } finally {
    await stub.close();
  }
});

test("ehloNameFrom cleans a host name and isEhloName validates names", () => {
  assert.equal(ehloNameFrom("web-1.example.com"), "web-1.example.com");
  assert.equal(ehloNameFrom("my host_1"), "my-host-1");
  assert.equal(ehloNameFrom(""), "localhost");
  assert.equal(ehloNameFrom("..."), "localhost");
  assert.equal(isEhloName("[192.0.2.1]"), true);
  assert.equal(isEhloName("[IPv6:::1]"), true);
  assert.equal(isEhloName("a.b-c.d"), true);
  for (const bad of ["", "-a", "a-", "a b", "a\r\nb", "a..b", "x".repeat(256), "[nope!]"]) {
    assert.equal(isEhloName(bad), false, JSON.stringify(bad));
  }
});

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
}

for (const isSilent of [true, false]) {
  const kind = isSilent ? "silent" : "accepting";
  test(`an abort right after the call opens no connection (${kind} server)`, async () => {
    const stub = await startSmtpStub({ isSilent });
    const controller = new AbortController();
    try {
      const sending = sendMail(options(stub.port, { signal: controller.signal }), message);
      controller.abort();
      await assert.rejects(sending, /aborted/);
      await settle();
      assert.equal(stub.accepted, 0);
      assert.equal(stub.open, 0);
      assert.equal(stub.messages.length, 0);
    } finally {
      await stub.close();
    }
  });

  test(`a timeout right after the call opens no connection (${kind} server)`, async () => {
    const stub = await startSmtpStub({ isSilent });
    const timers: (() => void)[] = [];
    try {
      const schedule = (fn: () => void): (() => void) => {
        timers.push(fn);
        return () => {};
      };
      const sending = sendMail(options(stub.port, { schedule }), message);
      timers[0]?.();
      await assert.rejects(sending, /timed out/);
      await settle();
      assert.equal(stub.accepted, 0);
      assert.equal(stub.open, 0);
      assert.equal(stub.messages.length, 0);
    } finally {
      await stub.close();
    }
  });
}

test("a signal that is already aborted rejects before any connection", async () => {
  const stub = await startSmtpStub();
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      sendMail(options(stub.port, { signal: controller.signal }), message),
      /aborted/,
    );
    await settle();
    assert.equal(stub.accepted, 0);
    assert.equal(stub.messages.length, 0);
  } finally {
    await stub.close();
  }
});

// Partial refusal: retries go only to the recipients that still need the message.

const A = "a@example.test";
const B = "b@example.test";
const C = "c@example.test";

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
    openedMs: 0,
  };
}

function statePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "notify-partial-"));
  dirs.push(dir);
  return join(dir, "state.json");
}

interface Chain {
  ledger: Ledger;
  delivery: ChannelDelivery;
  logger: ReturnType<typeof spyLogger>;
  attempts: () => number;
}

/** Email sender plus `ChannelDelivery` with a ledger, a fake sleep and the real `sendMail`. */
function chain(
  port: number,
  to: string[],
  path: string,
  over: {
    retryAttempts?: number;
    hooks?: LedgerOptions["hooks"];
    send?: SendMail;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  } = {},
): Chain {
  const logger = spyLogger();
  const ledger = new Ledger(path, over.hooks ? { hooks: over.hooks } : {});
  const sender = createEmailSender(
    {
      id: "mail",
      type: "email",
      smtp: { host: "127.0.0.1", port, tls: "none" },
      from: "pulse@example.test",
      to,
    },
    { sendMail: over.send ?? sendMail, schedule: () => () => {}, now: () => 0 },
  );
  let count = 0;
  const delivery = new ChannelDelivery({
    channelId: "mail",
    send: async (n, signal, progress) => {
      count++;
      await sender(n, signal, progress);
    },
    ledger,
    sleep: over.sleep ?? (async () => {}),
    retryDelayMs: 1,
    retryAttempts: over.retryAttempts ?? 5,
    logger,
  });
  return { ledger, delivery, logger, attempts: () => count };
}

/** The RCPT TO lines of each transaction, split at MAIL FROM. */
function transactions(stub: SmtpStub): string[][] {
  const result: string[][] = [];
  for (const command of stub.commands) {
    if (command.startsWith("MAIL FROM")) result.push([]);
    else if (command.startsWith("RCPT TO")) result.at(-1)?.push(command);
  }
  return result;
}

function storedFailed(path: string, key: string): RecipientProgress | undefined {
  const ledger = new Ledger(path);
  try {
    return ledger.failed().find((e) => e.key === key)?.recipients;
  } finally {
    ledger.close();
  }
}

test("a 4xx-refused recipient is retried alone; the delivered one gets no second copy", async () => {
  const stub = await startSmtpStub({ replies: { [`RCPT TO:<${B}`]: "451 4.2.0 try later" } });
  const path = statePath();
  const c = chain(stub.port, [A, B], path);
  try {
    c.delivery.enqueue(note("1:opened"));
    await c.delivery.idle();
    assert.deepEqual(transactions(stub), [
      [`RCPT TO:<${A}>`, `RCPT TO:<${B}>`],
      [`RCPT TO:<${B}>`],
    ]);
    assert.equal(stub.messages.length, 2);
    const [first, second] = stub.messages.map((m) => decodeMail(m).headers);
    assert.equal(first?.["message-id"], second?.["message-id"]);
    assert.equal(first?.to, `${A}, ${B}`);
    assert.equal(second?.to, `${A}, ${B}`);
    assert.equal(c.ledger.status("mail", "1:opened"), "delivered");
    assert.equal(c.attempts(), 2);
    const partly = c.logger.entries.find((e) => e.msg === "delivery attempt partly refused");
    assert.deepEqual(partly?.fields, {
      channel: "mail",
      key: "1:opened",
      attempt: 1,
      delivered: 1,
      refused: 0,
      remaining: 1,
      codes: [451],
    });
  } finally {
    c.ledger.close();
    await stub.close();
  }
});

test("2xx, 4xx and 5xx: only the 4xx one is retried and the event fails with c refused", async () => {
  const stub = await startSmtpStub({
    replies: { [`RCPT TO:<${B}`]: "451 later", [`RCPT TO:<${C}`]: "550 no such user" },
  });
  const path = statePath();
  const c = chain(stub.port, [A, B, C], path);
  try {
    c.delivery.enqueue(note("1:opened"));
    await c.delivery.idle();
    assert.deepEqual(transactions(stub), [
      [`RCPT TO:<${A}>`, `RCPT TO:<${B}>`, `RCPT TO:<${C}>`],
      [`RCPT TO:<${B}>`],
    ]);
    assert.equal(c.ledger.status("mail", "1:opened"), "failed");
    const failed = c.logger.entries.find((e) => e.msg === "notification delivery failed");
    assert.equal(failed?.fields.attempts, 2);
    assert.equal(failed?.fields.permanent, true);
    assert.equal(failed?.fields.error, "SMTP refused 1 of 3 recipients");
  } finally {
    c.ledger.close();
    await stub.close();
  }
  assert.deepEqual(storedFailed(path, "1:opened"), { delivered: [A, B], refused: [C] });
});

test("all recipients refused with 4xx: retryable, progress unchanged", async () => {
  const stub = await startSmtpStub({
    replies: { [`RCPT TO:<${A}`]: "451 later", [`RCPT TO:<${B}`]: "452 later" },
  });
  const c = chain(stub.port, [A, B], statePath());
  try {
    c.delivery.enqueue(note("1:opened"));
    await c.delivery.idle();
    assert.deepEqual(transactions(stub), [
      [`RCPT TO:<${A}>`, `RCPT TO:<${B}>`],
      [`RCPT TO:<${A}>`, `RCPT TO:<${B}>`],
    ]);
    assert.equal(c.ledger.status("mail", "1:opened"), "delivered");
    const warn = c.logger.entries.find((e) => e.msg === "delivery attempt failed");
    assert.equal(warn?.fields.error, "SMTP rejected the message: 451");
    assert.equal(
      c.logger.entries.filter((e) => e.msg === "delivery attempt partly refused").length,
      0,
    );
  } finally {
    c.ledger.close();
    await stub.close();
  }
});

test("all recipients refused with 5xx: failed after 1 attempt", async () => {
  const stub = await startSmtpStub({
    replies: { [`RCPT TO:<${A}`]: "550 no", [`RCPT TO:<${B}`]: "551 no" },
  });
  const path = statePath();
  const c = chain(stub.port, [A, B], path);
  try {
    c.delivery.enqueue(note("1:opened"));
    await c.delivery.idle();
    assert.equal(c.attempts(), 1);
    assert.equal(stub.messages.length, 0);
    assert.equal(c.ledger.status("mail", "1:opened"), "failed");
  } finally {
    c.ledger.close();
    await stub.close();
  }
  assert.deepEqual(storedFailed(path, "1:opened"), { delivered: [], refused: [A, B] });
});

test("an end-of-data 451 delivers nobody: the next transaction has both recipients", async () => {
  const stub = await startSmtpStub({ endOfDataReply: "451 later" });
  const c = chain(stub.port, [A, B], statePath(), { retryAttempts: 2 });
  try {
    c.delivery.enqueue(note("1:opened"));
    await c.delivery.idle();
    assert.deepEqual(transactions(stub), [
      [`RCPT TO:<${A}>`, `RCPT TO:<${B}>`],
      [`RCPT TO:<${A}>`, `RCPT TO:<${B}>`],
    ]);
    assert.equal(c.ledger.status("mail", "1:opened"), "failed");
    assert.equal(c.ledger.failed()[0]?.recipients, undefined);
  } finally {
    c.ledger.close();
    await stub.close();
  }
});

test("two events on one channel keep separate progress", async () => {
  // The first RCPT of b (event 1) and the first RCPT of a (event 2) are refused once.
  const stub = await startSmtpStub({ replies: { [`RCPT TO:<${B}`]: "451 later" } });
  const c = chain(stub.port, [A, B], statePath());
  try {
    c.delivery.enqueue(note("1:opened"));
    c.delivery.enqueue(note("2:opened"));
    await c.delivery.idle();
    // Event 1 sends to a and b (b refused); event 2 to a and b; event 1 retries b only.
    assert.deepEqual(transactions(stub), [
      [`RCPT TO:<${A}>`, `RCPT TO:<${B}>`],
      [`RCPT TO:<${A}>`, `RCPT TO:<${B}>`],
      [`RCPT TO:<${B}>`],
    ]);
    assert.equal(c.ledger.status("mail", "1:opened"), "delivered");
    assert.equal(c.ledger.status("mail", "2:opened"), "delivered");
  } finally {
    c.ledger.close();
    await stub.close();
  }
});

test("restart: a reopened ledger's pending progress sends only to b", async () => {
  const stub = await startSmtpStub({ replies: { [`RCPT TO:<${B}`]: "451 later" } });
  const path = statePath();
  let isWaiting: () => void = () => {};
  const waiting = new Promise<void>((resolve) => {
    isWaiting = resolve;
  });
  // The retry timer never ends: the process stops while the event is pending.
  const first = chain(stub.port, [A, B], path, {
    sleep: (_ms, signal) => {
      isWaiting();
      return new Promise((resolve) => signal?.addEventListener("abort", () => resolve()));
    },
  });
  first.delivery.enqueue(note("1:opened"));
  await waiting;
  first.delivery.stop();
  await first.delivery.idle();
  first.ledger.close();
  const second = chain(stub.port, [A, B], path);
  try {
    const pending = second.ledger.pending();
    assert.deepEqual(pending[0]?.recipients, { delivered: [A], refused: [] });
    for (const entry of pending) {
      if (entry.notification) second.delivery.enqueue(entry.notification, entry.recipients);
    }
    await second.delivery.idle();
    assert.deepEqual(transactions(stub), [
      [`RCPT TO:<${A}>`, `RCPT TO:<${B}>`],
      [`RCPT TO:<${B}>`],
    ]);
    assert.equal(second.ledger.status("mail", "1:opened"), "delivered");
  } finally {
    second.ledger.close();
    await stub.close();
  }
});

test("failed resend of the 2xx/4xx/5xx event sends only to c", async () => {
  const stub = await startSmtpStub({
    replies: { [`RCPT TO:<${B}`]: "451 later", [`RCPT TO:<${C}`]: "550 no" },
  });
  const path = statePath();
  const first = chain(stub.port, [A, B, C], path);
  first.delivery.enqueue(note("1:opened"));
  await first.delivery.idle();
  assert.equal(first.ledger.resend("mail", "1:opened"), "resent");
  first.ledger.close();
  const second = chain(stub.port, [A, B, C], path);
  try {
    const [entry] = second.ledger.pending();
    assert.deepEqual(entry?.recipients, { delivered: [A, B], refused: [] });
    if (entry?.notification) second.delivery.enqueue(entry.notification, entry.recipients);
    await second.delivery.idle();
    assert.deepEqual(transactions(stub).at(-1), [`RCPT TO:<${C}>`]);
    assert.equal(transactions(stub).length, 3);
    assert.equal(second.ledger.status("mail", "1:opened"), "delivered");
  } finally {
    second.ledger.close();
    await stub.close();
  }
});

test("a display name and an upper-case domain map to one id; the local part keeps its case", async () => {
  assert.equal(recipientId("Ops <Alice@Example.TEST>"), "Alice@example.test");
  const stub = await startSmtpStub();
  const c = chain(stub.port, ["Ops <Alice@Example.TEST>"], statePath());
  try {
    c.delivery.enqueue(note("1:opened"));
    await c.delivery.idle();
    assert.deepEqual(transactions(stub), [["RCPT TO:<Alice@example.test>"]]);
    assert.equal(c.ledger.status("mail", "1:opened"), "delivered");
  } finally {
    c.ledger.close();
    await stub.close();
  }
});

/** The email sender alone, with a fake `SendMail` that records each envelope. */
function fakeSender(to: string[], reply: (envelopeTo: string[]) => SendMailResult) {
  const calls: string[][] = [];
  const send = createEmailSender(
    {
      id: "mail",
      type: "email",
      smtp: { host: "127.0.0.1", port: 1, tls: "none" },
      from: "pulse@example.test",
      to,
    },
    {
      sendMail: async (_smtp, m) => {
        calls.push(m.envelopeTo);
        return reply(m.envelopeTo);
      },
      now: () => 0,
    },
  );
  return { send, calls };
}

async function partialOf(attempt: Promise<void>): Promise<PartialDeliveryError> {
  try {
    await attempt;
  } catch (err) {
    if (err instanceof PartialDeliveryError) return err;
    throw err;
  }
  throw new Error("attempt resolved");
}

test("changed recipients: delivered ids stay, added ones are tried, removed ones are left out", async () => {
  const { send, calls } = fakeSender([A, C], (envelope) => ({ accepted: envelope, refused: [] }));
  await send(note("1:opened"), undefined, { delivered: [A, B], refused: [] });
  assert.deepEqual(calls, [[C]]);
  const refusing = fakeSender([C], () => ({
    accepted: [],
    refused: [{ recipient: C, responseCode: 550 }],
  }));
  const err = await partialOf(
    refusing.send(note("1:opened"), undefined, { delivered: [A], refused: [] }),
  );
  assert.deepEqual(err.progress, { delivered: [A], refused: [C] });
  assert.equal(err.isPermanent, true);
});

test("nothing remaining connects to nothing", async () => {
  const done = fakeSender([A, B], () => ({ accepted: [], refused: [] }));
  await done.send(note("1:opened"), undefined, { delivered: [A, B], refused: [] });
  assert.deepEqual(done.calls, []);
  const refused = fakeSender([A, B], () => ({ accepted: [], refused: [] }));
  const err = await partialOf(
    refused.send(note("1:opened"), undefined, { delivered: [A], refused: [B] }),
  );
  assert.deepEqual(refused.calls, []);
  assert.equal(err.isPermanent, true);
  assert.equal(err.message, "SMTP refused 1 of 2 recipients");
});

test("an unexpected accepted or refused address is never recorded", async () => {
  const { send } = fakeSender([A, B], () => ({
    accepted: [A, "x@example.test"],
    refused: [{ recipient: "y@example.test", responseCode: 550 }],
  }));
  const err = await partialOf(send(note("1:opened"), undefined));
  assert.deepEqual(err.progress, { delivered: [A], refused: [] });
  assert.equal(err.isPermanent, false);
  assert.equal(err.remaining, 1);
});

test("an accepted address matches its id after the domain is lowercased", async () => {
  const { send, calls } = fakeSender(["Bob@example.test"], () => ({
    accepted: ["Bob@EXAMPLE.test"],
    refused: [],
  }));
  await assert.doesNotReject(send(note("1:opened"), undefined));
  assert.deepEqual(calls, [["Bob@example.test"]]);
});

test("a failed progress write is logged and the next attempt still skips a", async () => {
  const stub = await startSmtpStub({ replies: { [`RCPT TO:<${B}`]: "451 later" } });
  let isCounting = false;
  let commits = 0;
  const c = chain(stub.port, [A, B], statePath(), {
    hooks: {
      beforeCommit: () => {
        // Commit 1 is the claim, commit 2 the progress write.
        if (isCounting && ++commits === 2) throw new Error("disk full");
      },
    },
  });
  try {
    isCounting = true;
    c.delivery.enqueue(note("1:opened"));
    await c.delivery.idle();
    const log = c.logger.entries.find((e) => e.msg === "ledger recipient write failed");
    assert.deepEqual(log?.fields, { channel: "mail", key: "1:opened", error: "disk full" });
    assert.deepEqual(transactions(stub), [
      [`RCPT TO:<${A}>`, `RCPT TO:<${B}>`],
      [`RCPT TO:<${B}>`],
    ]);
    assert.equal(c.ledger.status("mail", "1:opened"), "delivered");
  } finally {
    c.ledger.close();
    await stub.close();
  }
});

test("other SMTP failures change no progress and keep their classification", async () => {
  for (const [replies, isPermanent] of [
    [{ "MAIL FROM": "550 no" }, true],
    [{ DATA: "451 later" }, false],
  ] as const) {
    const stub = await startSmtpStub({ replies: { ...replies } });
    const c = chain(stub.port, [A, B], statePath(), { retryAttempts: 1 });
    try {
      c.delivery.enqueue(note("1:opened"));
      await c.delivery.idle();
      const failed = c.ledger.failed()[0];
      assert.equal(failed?.recipients, undefined);
      const log = c.logger.entries.find((e) => e.msg === "notification delivery failed");
      assert.equal(log?.fields.permanent === true, isPermanent);
    } finally {
      c.ledger.close();
      await stub.close();
    }
  }
});

test("a secret and CR/LF in a refusal reply reach no log, error or ledger", async () => {
  const marker = "MARKER-SECRET-77";
  const stub = await startSmtpStub({
    replies: { [`RCPT TO:<${B}`]: `550-${marker}\r\n550 ${marker}` },
  });
  const path = statePath();
  const c = chain(stub.port, [A, B], path);
  try {
    c.delivery.enqueue(note("1:opened"));
    await c.delivery.idle();
    assert.equal(c.ledger.status("mail", "1:opened"), "failed");
    const failed = c.logger.entries.find((e) => e.msg === "notification delivery failed");
    assert.equal(failed?.fields.error, "SMTP refused 1 of 2 recipients: 550");
    assert.equal(JSON.stringify(c.logger.entries).includes(marker), false);
  } finally {
    c.ledger.close();
    await stub.close();
  }
  for (const file of [path, `${path}-wal`]) {
    try {
      assert.equal(readFileSync(file, "latin1").includes(marker), false, file);
    } catch (err) {
      // The WAL may be gone after close; only its absence is acceptable.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
});
