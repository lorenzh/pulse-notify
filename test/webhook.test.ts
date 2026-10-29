import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createWebhookSender } from "../src/channels/webhook.ts";
import type { Notification, Schedule } from "../src/types.ts";
import { close, listen, startReceiver } from "./support.ts";

const note: Notification = {
  key: "7:opened",
  event: "opened",
  incidentId: 7,
  checkId: "c",
  checkName: "C",
  reason: "HTTP 500",
  time: "2026-01-01T00:00:00.000Z",
  timeMs: 1767225600000,
};

test("posts JSON with idempotency key; 2xx is success", async () => {
  const rx = await startReceiver();
  try {
    await createWebhookSender({ id: "h", type: "webhook", url: rx.url })(note);
    const [req] = rx.requests;
    assert.equal(req?.method, "POST");
    assert.equal(req?.headers["content-type"], "application/json");
    assert.equal(req?.headers["idempotency-key"], "7:opened");
    assert.deepEqual(req?.body, note);
  } finally {
    await rx.close();
  }
});

test("non-2xx is a failure", async () => {
  const rx = await startReceiver();
  rx.status = 500;
  try {
    await assert.rejects(
      createWebhookSender({ id: "h", type: "webhook", url: rx.url })(note),
      /status 500/,
    );
    rx.status = 204;
    await createWebhookSender({ id: "h", type: "webhook", url: rx.url })(note);
  } finally {
    await rx.close();
  }
});

test("a redirect is a failure and is not followed", async () => {
  const target = await startReceiver();
  const redirector = createServer((_req, res) => {
    res.statusCode = 302;
    res.setHeader("location", target.url);
    res.end();
  });
  const url = await listen(redirector);
  try {
    await assert.rejects(
      createWebhookSender({ id: "h", type: "webhook", url })(note),
      /status 302/,
    );
    assert.equal(target.requests.length, 0);
  } finally {
    await close(redirector);
    await target.close();
  }
});

test("a network error is a failure", async () => {
  const rx = await startReceiver();
  const url = rx.url;
  await rx.close();
  await assert.rejects(createWebhookSender({ id: "h", type: "webhook", url })(note));
});

test("a hanging server times out via the injected timer", async () => {
  const hang = createServer(() => {});
  const url = await listen(hang);
  let delay = -1;
  const schedule: Schedule = (fn, ms) => {
    delay = ms;
    queueMicrotask(fn);
    return () => {};
  };
  try {
    await assert.rejects(
      createWebhookSender({ id: "h", type: "webhook", url }, { timeoutMs: 1234, schedule })(note),
      /timeout after 1234ms/,
    );
    assert.equal(delay, 1234);
  } finally {
    await close(hang);
  }
});

test("a stalled response body times out via the injected timer", async () => {
  let fire: (() => void) | undefined;
  const stalled: typeof fetch = async () =>
    // Cancelling this body never completes, like a connection that stalls while closing.
    new Response(new ReadableStream({ cancel: () => new Promise<void>(() => {}) }), {
      status: 200,
    });
  const send = createWebhookSender(
    { id: "h", type: "webhook", url: "http://127.0.0.1:1/" },
    {
      fetch: stalled,
      timeoutMs: 20,
      schedule: (fn) => {
        fire = fn;
        return () => {};
      },
    },
  );
  const sending = send(note);
  await new Promise((r) => setImmediate(r));
  fire?.();
  await assert.rejects(sending, /timeout after 20ms/);
});
