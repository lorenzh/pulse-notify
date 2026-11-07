import { afterAll, expect, test } from "bun:test";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SUBSCRIPTION_ROUTES, validateSubscriptionAnswer } from "@lorenzh/pulse-contract";
import type { MailMessage, SendMail, SmtpOptions } from "../src/channels/mailer.ts";
import { main } from "../src/index.ts";
import { tempDir } from "./subscriptions-support.ts";
import { manualIncident, startFakeApi } from "./support.ts";

const ADDRESS = "visitor.secret@example.com";
const NORMALIZED = "visitor.secret@example.com";
const BEARER = "b".repeat(40);
const KEY = "fedcba9876543210".repeat(4);
const PASSWORD = "smtp-pass-9f8e7d";

async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

interface Sent {
  smtp: SmtpOptions;
  message: MailMessage;
}

/** Confirmation mails succeed; incident mails fail with a server text that echoes secrets. */
function recordingSend(sent: Sent[]): SendMail {
  return async (smtp, message) => {
    sent.push({ smtp, message });
    if (message.subject.includes("Confirm")) {
      return { accepted: message.envelopeTo, refused: [] };
    }
    throw new Error(`451 4.3.0 ${NORMALIZED} rejected for user pulse password ${PASSWORD}`);
  };
}

test("full flow with a failing SMTP leaks no address, token, key, bearer or password; files are private", async () => {
  const tmp = tempDir("notify-subs-sec-");
  afterAll(() => tmp.remove());
  const api = await startFakeApi();
  afterAll(() => api.close());
  api.manualIncidents = [];
  writeFileSync(join(tmp.dir, "token"), `${BEARER}\n`);
  writeFileSync(join(tmp.dir, "key"), `${KEY}\n`);
  writeFileSync(join(tmp.dir, "pw"), `${PASSWORD}\n`);
  writeFileSync(
    join(tmp.dir, "config.json"),
    JSON.stringify({ channels: [{ id: "log", type: "file", path: join(tmp.dir, "o.jsonl") }] }),
  );
  const sent: Sent[] = [];
  const lines: string[] = [];
  const running = main(
    {
      PULSE_API_URL: api.url,
      PULSE_NOTIFY_CONFIG: join(tmp.dir, "config.json"),
      PULSE_NOTIFY_STATE: join(tmp.dir, "state.json"),
      PULSE_NOTIFY_POLL_MS: "20",
      PULSE_NOTIFY_RETRY_ATTEMPTS: "1",
      PULSE_LOG_LEVEL: "debug",
      PULSE_HEALTH_PORT: "0",
      PULSE_NOTIFY_SUBSCRIPTIONS: "on",
      PULSE_NOTIFY_SUBSCRIPTIONS_STATUS_URL: "https://status.example.com/",
      PULSE_NOTIFY_SUBSCRIPTIONS_FROM: "Pulse <status@example.com>",
      PULSE_NOTIFY_SUBSCRIPTIONS_SMTP_HOST: "127.0.0.1",
      PULSE_NOTIFY_SUBSCRIPTIONS_SMTP_TLS: "none",
      PULSE_NOTIFY_SUBSCRIPTIONS_SMTP_USERNAME: "pulse",
      PULSE_NOTIFY_SUBSCRIPTIONS_SMTP_PASSWORD_FILE: join(tmp.dir, "pw"),
      PULSE_NOTIFY_SUBSCRIPTIONS_TOKEN_FILE: join(tmp.dir, "token"),
      PULSE_NOTIFY_SUBSCRIPTIONS_KEY_FILE: join(tmp.dir, "key"),
      PULSE_NOTIFY_SUBSCRIPTIONS_HOST: "127.0.0.1",
      PULSE_NOTIFY_SUBSCRIPTIONS_PORT: "0",
    },
    { write: (line) => lines.push(line), subscriptionSendMail: recordingSend(sent) },
  );
  const answers: string[] = [];
  try {
    const port = await running.subscriptionsListening;
    const healthPort = await running.listening;
    const base = `http://127.0.0.1:${port}`;
    const post = async (
      path: string,
      body: string,
      headers: Record<string, string> = {},
      method = "POST",
    ): Promise<{ status: number; text: string }> => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${BEARER}`,
          "content-type": "application/json",
          ...headers,
        },
        ...(method === "POST" ? { body } : {}),
      });
      const text = await res.text();
      answers.push(text);
      expect(res.headers.get("cache-control")).toBe("no-store");
      return { status: res.status, text };
    };
    const subscribeBody = JSON.stringify({ email: ADDRESS });

    expect((await post(SUBSCRIPTION_ROUTES.subscribe, subscribeBody)).status).toBe(202);
    await until(() => sent.length === 1, "confirmation mail");
    const confirmation = sent[0];
    if (confirmation === undefined) throw new Error("no confirmation");
    const confirmToken = /token=([A-Za-z0-9_-]{43})\n/.exec(confirmation.message.text)?.[1];
    const unsubscribeToken = /unsubscribe\?token=([A-Za-z0-9_.-]+)/.exec(
      confirmation.message.text,
    )?.[1];
    if (confirmToken === undefined || unsubscribeToken === undefined) throw new Error("no links");
    expect(confirmation.smtp.password).toBe(PASSWORD);

    // Every status of R1, each with the request's token or address in the body.
    const withToken = JSON.stringify({ token: confirmToken });
    expect((await post("/nope", subscribeBody)).status).toBe(404);
    expect((await post(SUBSCRIPTION_ROUTES.subscribe, "", {}, "GET")).status).toBe(405);
    expect(
      (await post(SUBSCRIPTION_ROUTES.confirm, withToken, { authorization: "Bearer wrong" }))
        .status,
    ).toBe(401);
    expect(
      (await post(SUBSCRIPTION_ROUTES.subscribe, subscribeBody, { "content-type": "text/plain" }))
        .status,
    ).toBe(415);
    const big = JSON.stringify({ email: ADDRESS, pad: "x".repeat(1100) });
    expect((await post(SUBSCRIPTION_ROUTES.subscribe, big)).status).toBe(413);
    expect((await post(SUBSCRIPTION_ROUTES.subscribe, `{"email":"${ADDRESS}"`)).status).toBe(400);
    const bad = JSON.stringify({ email: ADDRESS, extra: confirmToken });
    expect((await post(SUBSCRIPTION_ROUTES.subscribe, bad)).status).toBe(400);
    const wrongMac = `${unsubscribeToken.slice(0, 23)}${"A".repeat(43)}`;
    expect(
      (await post(SUBSCRIPTION_ROUTES.unsubscribe, JSON.stringify({ token: wrongMac }))).status,
    ).toBe(404);
    const confirmed = await post(SUBSCRIPTION_ROUTES.confirm, withToken);
    expect(confirmed.status).toBe(200);
    expect(validateSubscriptionAnswer(JSON.parse(confirmed.text)).ok).toBe(true);

    // A public incident; its send fails with the address and password in the server reply.
    const publishedAt = Date.now() + 1000;
    api.manualIncidents = [
      manualIncident({
        id: 7,
        title: "Search outage",
        createdAt: publishedAt,
        updates: [{ at: publishedAt, status: "investigating", message: "We are looking." }],
      }),
    ];
    await until(() => sent.length === 2, "incident mail");
    let metrics = "";
    for (let i = 0; i < 400; i += 1) {
      metrics = await (await fetch(`http://127.0.0.1:${healthPort}/metrics`)).text();
      if (
        metrics.includes('pulse_notify_subscriber_mails_total{kind="incident",outcome="failure"} 1')
      )
        break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(metrics).toContain(
      'pulse_notify_subscriber_mails_total{kind="incident",outcome="failure"} 1',
    );
    const unsubscribed = await post(
      SUBSCRIPTION_ROUTES.unsubscribe,
      JSON.stringify({ token: unsubscribeToken }),
    );
    expect(unsubscribed.status).toBe(200);

    for (const { message } of sent) {
      expect(message.to).toEqual([NORMALIZED]);
      expect(message.envelopeTo).toEqual([NORMALIZED]);
      expect(/[\r\n]/.test(message.subject)).toBe(false);
    }
    const secrets = [ADDRESS, NORMALIZED, confirmToken, unsubscribeToken, KEY, BEARER, PASSWORD];
    const surfaces = { logs: lines.join("\n"), metrics, answers: answers.join("\n") };
    for (const [surface, text] of Object.entries(surfaces)) {
      for (const secret of secrets) {
        expect({ surface, leaked: text.toLowerCase().includes(secret.toLowerCase()) }).toEqual({
          surface,
          leaked: false,
        });
      }
    }
    const store = join(tmp.dir, "notify-subscriptions.db");
    expect(statSync(store).mode & 0o777).toBe(0o600);
    expect(statSync(`${store}.lock`).mode & 0o777).toBe(0o600);
  } finally {
    await running.stop();
  }
  expect(running.subscriberGuardSize()).toBe(0);
});
