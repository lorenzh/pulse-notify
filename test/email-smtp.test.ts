import { beforeAll, test } from "bun:test";
import assert from "node:assert/strict";
import {
  ehloNameFrom,
  isEhloName,
  type MailMessage,
  type SmtpOptions,
} from "../src/channels/mailer.ts";
import { sendMail } from "../src/channels/smtp-send.ts";
import { errorFields, PermanentDeliveryError } from "../src/errors.ts";
import { decodeHeader, decodeMail } from "./mail-decode.ts";
import { makeCert, startSmtpStub, startTlsSmtpStub, type TestCert } from "./smtp-stub.ts";

let cert: TestCert;
beforeAll(() => {
  cert = makeCert();
});

const message: MailMessage = {
  from: "pulse@example.com",
  to: ["a@example.com", "b@example.com"],
  subject: "hi",
  text: ".dot line\nplain\n",
  date: new Date(Date.UTC(2026, 0, 1, 12, 0, 0)),
  messageId: "<abc@example.com>",
};
/** One recipient, so a refused RCPT leaves nobody to deliver to. */
const single: MailMessage = { ...message, to: ["a@example.com"] };

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

test("a 4xx and a 5xx reply reject", async () => {
  for (const reply of ["451 try later", "550 no such user"]) {
    const stub = await startSmtpStub({ replies: { "RCPT TO:<a@": reply } });
    try {
      await assert.rejects(sendMail(options(stub.port), message), new RegExp(reply.slice(0, 3)));
    } finally {
      await stub.close();
    }
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
  await assert.rejects(
    sendMail(options(1), { ...message, to: ["a@example.com\r\nRCPT TO:<x@y>"] }),
    /line break/,
  );
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
    { "RCPT TO": `550 ${echo}` },
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

test("a 5xx reply is a permanent error at every stage, a 4xx is not", async () => {
  for (const verb of ["EHLO", "MAIL FROM", "RCPT TO", "DATA"]) {
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
