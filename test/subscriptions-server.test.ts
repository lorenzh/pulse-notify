import { afterEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { type ErrorResponse, validateSubscriptionAnswer } from "@lorenzh/pulse-contract";
import { type SubscriptionServer, startSubscriptionServer } from "../src/subscription-server.ts";
import {
  confirmTokenOf,
  countRows,
  letLoopRun,
  type SubscriptionFixture,
  subscriptionFixture,
  TEST_BEARER,
  TEST_KEY,
  testUnsubscribeToken,
} from "./subscriptions-support.ts";

let fx: SubscriptionFixture | undefined;
let server: SubscriptionServer | undefined;
let errors: string[] = [];

afterEach(async () => {
  await server?.close();
  await fx?.close();
  server = undefined;
  fx = undefined;
  errors = [];
});

async function start(opts: Parameters<typeof subscriptionFixture>[0] = {}): Promise<{
  f: SubscriptionFixture;
  url: string;
}> {
  const f = subscriptionFixture(opts);
  fx = f;
  server = await startSubscriptionServer({
    host: "127.0.0.1",
    port: 0,
    token: TEST_BEARER,
    ops: f.ops,
    now: f.clock.now,
    logError: (message, fields) => errors.push(`${message} ${JSON.stringify(fields)}`),
  });
  return { f, url: `http://127.0.0.1:${server.port}` };
}

interface Answer {
  status: number;
  headers: Headers;
  text: string;
}

async function post(
  url: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<Answer> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TEST_BEARER}`,
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

function expectError(a: Answer, status: number, error: string): void {
  expect(a.status).toBe(status);
  const body: ErrorResponse = JSON.parse(a.text) as ErrorResponse;
  expect(body).toEqual({ error });
  expectHeaders(a);
}

function expectHeaders(a: Answer): void {
  expect(a.headers.get("content-type")).toBe("application/json");
  expect(a.headers.get("cache-control")).toBe("no-store");
  expect(a.headers.get("x-pulse-contract")).toBe("1");
}

function expectAnswer(a: Answer, status: number, result: string): void {
  expect(a.status).toBe(status);
  const v = validateSubscriptionAnswer(JSON.parse(a.text));
  expect(v.ok && v.value.status).toBe(result as never);
  expect(a.text).toBe(`{"status":"${result}"}`);
  expectHeaders(a);
}

describe("Notify listener (R4)", () => {
  test("path 404, method 405 with allow POST", async () => {
    const { url } = await start();
    expectError(await post(`${url}/subscriptions/other`, "{}"), 404, "not found");
    const get = await fetch(`${url}/subscriptions`);
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
  });

  test("bearer: missing, one character more, or wrong with 2 MiB → 401; store unchanged", async () => {
    const { f, url } = await start();
    const body = JSON.stringify({ email: "a@example.com" });
    const res = await fetch(`${url}/subscriptions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expectError(
      { status: res.status, headers: res.headers, text: await res.text() },
      401,
      "unauthorized",
    );
    expectError(
      await post(`${url}/subscriptions`, body, { authorization: `Bearer ${TEST_BEARER}x` }),
      401,
      "unauthorized",
    );
    expect(countRows(f.path, "SELECT count(*) AS n FROM subscriptions")).toBe(0);
  });

  test("wrong bearer with a 2 MiB body is answered 401 before the body is read", async () => {
    const { url } = await start();
    const port = new URL(url).port;
    const head = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(port), "127.0.0.1");
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString();
      });
      socket.on("close", () => resolve(data));
      socket.on("error", reject);
      socket.write(
        "POST /subscriptions HTTP/1.1\r\nhost: x\r\nauthorization: Bearer wrong\r\n" +
          `content-type: application/json\r\ncontent-length: ${2 * 1024 * 1024}\r\n\r\n{"email":`,
      );
    });
    expect(head.startsWith("HTTP/1.1 401")).toBe(true);
    expect(head.endsWith('{"error":"unauthorized"}')).toBe(true);
  });

  test("content type 415, size 413 at 1025 bytes, JSON and strict validation 400", async () => {
    const { url } = await start();
    const sub = `${url}/subscriptions`;
    expectError(
      await post(sub, '{"email":"a@example.com"}', { "content-type": "text/plain" }),
      415,
      "unsupported media type",
    );
    const big = '{"email":"a@example.com"}';
    const exact = `${big}${" ".repeat(1025 - big.length)}`;
    const fits = `${big}${" ".repeat(1024 - big.length)}`;
    expectAnswer(await post(sub, fits), 202, "accepted");
    expect(Buffer.byteLength(exact)).toBe(1025);
    expectError(await post(sub, exact), 413, "payload too large");
    expectError(await post(sub, "{nope"), 400, "invalid json");
    expectError(await post(sub, '{"email":"a@example.com","extra":1}'), 400, "invalid request");
    expectError(
      await post(`${url}/subscriptions/confirm`, JSON.stringify({ token: "a".repeat(44) })),
      400,
      "invalid request",
    );
    expectError(
      await post(`${url}/subscriptions/unsubscribe`, JSON.stringify({ token: "a".repeat(43) })),
      400,
      "invalid request",
    );
    expectAnswer(
      await post(sub, '{"email":"a@example.com"}', {
        "content-type": "application/json; charset=utf-8",
      }),
      202,
      "accepted",
    );
  });

  test("subscribe, confirm and unsubscribe over HTTP; no answer echoes address or token", async () => {
    const { f, url } = await start();
    const email = "sub-a@example.com";
    const sub = await post(`${url}/subscriptions`, JSON.stringify({ email }));
    expectAnswer(sub, 202, "accepted");
    await letLoopRun();
    const token = f.mailer.calls[0] === undefined ? "" : confirmTokenOf(f.mailer.calls[0]);
    const unknown = await post(
      `${url}/subscriptions/confirm`,
      JSON.stringify({ token: "b".repeat(43) }),
    );
    expectError(unknown, 404, "invalid token");
    const ok = await post(`${url}/subscriptions/confirm`, JSON.stringify({ token }));
    expectAnswer(ok, 200, "confirmed");
    const id = readId(f, email);
    const unsub = testUnsubscribeToken(id, TEST_KEY);
    const wrongMac = testUnsubscribeToken(id, "c".repeat(64));
    expectError(
      await post(`${url}/subscriptions/unsubscribe`, JSON.stringify({ token: wrongMac })),
      404,
      "invalid token",
    );
    expectAnswer(
      await post(`${url}/subscriptions/unsubscribe`, JSON.stringify({ token: unsub })),
      200,
      "unsubscribed",
    );
    expectAnswer(
      await post(`${url}/subscriptions/unsubscribe`, JSON.stringify({ token: unsub })),
      200,
      "unsubscribed",
    );
    for (const a of [sub, unknown, ok]) {
      expect(a.text).not.toContain("sub-a");
      expect(a.text).not.toContain(token);
    }
  });

  test("a store error answers 503 unavailable for known and unknown addresses; no address in logs", async () => {
    const { f, url } = await start();
    f.ops.subscribe("known@example.com", 0);
    f.store.close();
    for (const email of ["known@example.com", "unknown@example.com"]) {
      expectError(
        await post(`${url}/subscriptions`, JSON.stringify({ email })),
        503,
        "unavailable",
      );
    }
    expect(errors).toHaveLength(2);
    expect(errors.join("\n")).not.toContain("@example.com");
  });

  test("subscribe() is not a Promise for queued, known and limited", async () => {
    const { f } = await start({ max: 1, maxPending: 1 });
    const results = [
      f.ops.subscribe("a@example.com", 0),
      f.ops.subscribe("a@example.com", 1),
      f.ops.subscribe("b@example.com", 2),
    ];
    expect(results).toEqual(["queued", "known", "limited"]);
    for (const r of results) expect(r).not.toBeInstanceOf(Promise);
  });
});

function readId(f: SubscriptionFixture, email: string): string {
  const db = f.store.subscriptionByEmail(email);
  return db?.id ?? "";
}
