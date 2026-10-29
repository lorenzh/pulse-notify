import assert from "node:assert/strict";
import { before, test } from "node:test";
import { dotStuff, type SmtpOptions, sendMail } from "../src/channels/smtp.ts";
import { makeCert, startSmtpStub, startTlsSmtpStub, type TestCert } from "./smtp-stub.ts";

let cert: TestCert;
before(() => {
  cert = makeCert();
});

const message = {
  from: "pulse@example.com",
  to: ["a@example.com", "b@example.com"],
  data: "Subject: hi\r\n\r\n.dot line\r\nplain\r\n",
};

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

test("dotStuff doubles leading dots and normalizes line endings", () => {
  assert.equal(dotStuff("a\n.b\r\n..c"), "a\r\n..b\r\n...c\r\n");
});

test("sends the full conversation with dot-stuffing and every recipient", async () => {
  const stub = await startSmtpStub();
  try {
    await sendMail(options(stub.port), message);
    assert.deepEqual(stub.commands, [
      "EHLO localhost",
      "MAIL FROM:<pulse@example.com>",
      "RCPT TO:<a@example.com>",
      "RCPT TO:<b@example.com>",
      "DATA",
      "QUIT",
    ]);
    assert.equal(stub.messages[0], "Subject: hi\r\n\r\n..dot line\r\nplain");
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

test("no AUTH mechanism in common rejects", async () => {
  const stub = await startSmtpStub();
  try {
    await assert.rejects(
      sendMail(options(stub.port, { username: "u", password: "p" }), message),
      /no supported AUTH/,
    );
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
    await assert.rejects(sendMail(options(stub.port, { tls: "starttls" }), message), /STARTTLS/);
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
      assert.equal(stub.messages.length, 0);
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
