import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  type Validation,
  validateNotifyChannelRecord,
  validateResendClaimResponse,
} from "@lorenzh/pulse-contract";
import { fetchChecks, getService, sendService } from "../src/api.ts";
import { main } from "../src/index.ts";
import { checkChannelsAnswer, resolveDatabaseChannel } from "../src/remote-channels.ts";
import { close, fakeFetch, listen, spyLogger, startFakeApi } from "./support.ts";

const MARKER = "security-upstream-secret-7a93";
const TOKEN = "security-bearer-secret-6b21";
const REV = `sha256-${"1".repeat(64)}`;
const record = {
  id: "hook",
  type: "webhook",
  urlEnv: "PULSE_NOTIFY_SECRET_HOOK",
  createdAt: 1,
  updatedAt: 2,
};
const accept = (raw: unknown): Validation<unknown> => ({ ok: true, value: raw });

test("security remote: GET POST PUT refuse redirects without forwarding Bearer", async () => {
  let targetHits = 0;
  const target = createServer((_req, res) => {
    targetHits++;
    res.end("{}");
  });
  const destination = await listen(target);
  let status = 301;
  const headers: (string | undefined)[] = [];
  const origin = createServer((req, res) => {
    headers.push(req.headers.authorization);
    if (req.url === "/checks") {
      res.end("[]");
      return;
    }
    res.writeHead(status, { location: `${destination}/${MARKER}` });
    res.end(MARKER);
  });
  const baseUrl = await listen(origin);
  try {
    for (const code of [301, 302, 303, 307, 308]) {
      status = code;
      const opts = { baseUrl, token: TOKEN };
      await assert.rejects(getService(opts, "service/notify/channels", accept), /returned 30/);
      for (const method of ["POST", "PUT"] as const) {
        const result = await sendService(opts, method, "service/notify/report", {}, accept);
        assert.equal(result.ok, false);
        assert.equal(JSON.stringify(result).includes(MARKER), false);
        assert.equal(JSON.stringify(result).includes(TOKEN), false);
      }
    }
    assert.equal(targetHits, 0);
    assert.equal(headers.length, 15);
    assert.ok(headers.every((h) => h === `Bearer ${TOKEN}`));
    await fetchChecks({ baseUrl });
    assert.equal(headers.at(-1), undefined);
  } finally {
    await close(origin);
    await close(target);
  }
});

test("security remote: GET POST PUT bound decoded chunked and gzip answers", async () => {
  const body = JSON.stringify({ pad: "x".repeat(1_048_576) });
  let isGzip = false;
  const server = createServer((_req, res) => {
    if (isGzip) {
      res.writeHead(200, { "content-encoding": "gzip" });
      res.end(gzipSync(body));
    } else {
      res.writeHead(200, { "transfer-encoding": "chunked" });
      res.write(body.slice(0, 200));
      res.end(body.slice(200));
    }
  });
  const baseUrl = await listen(server);
  try {
    for (const compressed of [false, true]) {
      isGzip = compressed;
      const opts = { baseUrl, token: TOKEN };
      const expected = compressed ? /content-encoding is not supported/ : /1048576 bytes/;
      await assert.rejects(getService(opts, "service/notify/channels", accept), expected);
      for (const method of ["POST", "PUT"] as const) {
        const result = await sendService(opts, method, "service/notify/report", {}, accept);
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.kind, compressed ? "network" : "too-large");
      }
    }
  } finally {
    await close(server);
  }
});

test("security remote: server text and token are absent across service failures", async () => {
  const cases = [
    () => new Response(MARKER, { status: 500, statusText: MARKER }),
    () => new Response(MARKER),
    () => new Response("{}", { headers: { "x-pulse-contract": MARKER } }),
    () => Response.json({ commands: [{ id: MARKER }] }),
  ];
  for (const answer of cases) {
    const opts = {
      baseUrl: "https://127.0.0.1:1",
      token: TOKEN,
      fetch: fakeFetch(async () => answer()),
    };
    const err: unknown = await getService(
      opts,
      "service/notify/channels",
      validateResendClaimResponse,
    ).catch((e: unknown) => e);
    assert.ok(err instanceof Error);
    assert.equal(err.message.includes(MARKER), false);
    assert.equal(err.message.includes(TOKEN), false);
    assert.equal(err.cause, undefined);
    const dir = mkdtempSync(join(tmpdir(), "notify-security-boundary-"));
    const api = await startFakeApi();
    const logger = spyLogger();
    const timers: { fn: () => void; ms: number }[] = [];
    const schedule = (fn: () => void, ms: number): (() => void) => {
      timers.push({ fn, ms });
      return () => {};
    };
    const running = main(
      {
        PULSE_API_URL: api.url,
        PULSE_NOTIFY_API_TOKEN: TOKEN,
        PULSE_NOTIFY_STATE: join(dir, "state.db"),
      },
      {
        logger,
        serviceFetch: opts.fetch,
        channelSchedule: schedule,
        commandSchedule: schedule,
      },
    );
    try {
      await running.listening;
      for (const timer of [...timers]) if (timer.ms === 0) timer.fn();
      await running.stop();
      assert.ok(
        logger.entries.some(
          (entry) =>
            entry.msg === "channels read failed, keeping the last good channels" ||
            entry.msg === "channels answer refused, keeping the last good channels",
        ),
      );
      assert.ok(
        logger.entries.some((entry) => entry.msg === "resend claim failed, the next poll retries"),
      );
      assert.equal(JSON.stringify(logger.entries).includes(MARKER), false);
      assert.equal(JSON.stringify(logger.entries).includes(TOKEN), false);
    } finally {
      await running.stop();
      await api.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("security remote: injected 5000ms timeout aborts GET POST PUT and forbids HTTPS downgrade", async () => {
  for (const method of ["GET", "POST", "PUT"] as const) {
    let expire: (() => void) | undefined;
    let signal: AbortSignal | null | undefined;
    const opts = {
      baseUrl: "https://127.0.0.1:1",
      token: TOKEN,
      schedule: (fn: () => void, ms: number) => {
        assert.equal(ms, 5000);
        expire = fn;
        return () => {};
      },
      fetch: fakeFetch(async (_input, init) => {
        assert.equal(init?.redirect, "manual");
        signal = init?.signal;
        return new Promise<Response>(() => {});
      }),
    };
    const pending =
      method === "GET"
        ? getService(opts, "service/notify/channels", accept).catch((e: unknown) => e)
        : sendService(opts, method, "service/notify/report", {}, accept);
    assert.ok(expire);
    expire();
    const result: unknown = await pending;
    assert.equal(signal?.aborted, true);
    assert.equal(JSON.stringify(result).includes(TOKEN), false);
    let hits = 0;
    const redirecting = {
      ...opts,
      fetch: fakeFetch(async (_input, init) => {
        hits++;
        assert.equal(init?.redirect, "manual");
        return new Response(null, { status: 307, headers: { location: "http://127.0.0.1:1" } });
      }),
    };
    if (method === "GET")
      await assert.rejects(getService(redirecting, "service/notify/channels", accept));
    else
      assert.equal(
        (await sendService(redirecting, method, "service/notify/report", {}, accept)).ok,
        false,
      );
    assert.equal(hits, 1);
  }
});

test("security remote: validators never invoke getters and reject hostile JSON shapes", () => {
  let getters = 0;
  const getter = (): never => {
    getters++;
    throw new Error(MARKER);
  };
  for (const key of ["id", "type", "urlEnv", "constructor", "__proto__"]) {
    const raw = { ...record };
    Object.defineProperty(raw, key, { get: getter, enumerable: true });
    assert.doesNotThrow(() => checkChannelsAnswer({ revision: REV, channels: [raw] }));
    assert.doesNotThrow(() => validateNotifyChannelRecord(raw));
  }
  const list = [record];
  Object.defineProperty(list, "0", { get: getter });
  assert.equal(checkChannelsAnswer({ revision: REV, channels: list }).kind, "envelope");
  const commands = [{}];
  Object.defineProperty(commands, "0", { get: getter });
  assert.equal(validateResendClaimResponse({ commands }).ok, false);
  for (const raw of [
    null,
    true,
    42,
    "x".repeat(100_000),
    [],
    { commands: null },
    { commands: [], extra: 1 },
  ]) {
    assert.equal(validateResendClaimResponse(raw).ok, false);
  }
  for (const field of ["urlEnv", "urlFile", "secretEnv", "secretFile"]) {
    for (const value of [null, 42, "x".repeat(100_000), "../token", "x\ty", "x\ry", "x\ny"]) {
      assert.equal(validateNotifyChannelRecord({ ...record, [field]: value }).ok, false);
    }
  }
  for (const field of ["urlEnv", "secretEnv"]) {
    assert.equal(
      validateNotifyChannelRecord({ ...record, [field]: "PULSE_NOTIFY_API_TOKEN" }).ok,
      false,
    );
  }
  for (const key of ["__proto__", "constructor", "url", "password", "secret"]) {
    const raw: unknown = JSON.parse(JSON.stringify(record).replace(/}$/, `,"${key}":"${MARKER}"}`));
    assert.equal(validateNotifyChannelRecord(raw).ok, false);
  }
  assert.equal(getters, 0);
});

test("security remote: resolved destinations obey chat TLS and SMTP auth rules", () => {
  const env = { PULSE_NOTIFY_SECRET_HOOK: "", PULSE_NOTIFY_SECRET_PASSWORD: MARKER };
  const context = { env, secretDir: undefined, realpath: (p: string) => p, readFile: () => MARKER };
  for (const type of ["slack", "teams"] as const) {
    for (const url of [
      // eslint-disable-next-line sonarjs/no-clear-text-protocols -- rejected fixture URL is never requested
      "http://192.168.1.1/hook",
      "http://169.254.169.254/latest",
      "file:///etc/passwd",
      "ftp://127.0.0.1/hook",
    ]) {
      env.PULSE_NOTIFY_SECRET_HOOK = url;
      const checked = validateNotifyChannelRecord({ ...record, type });
      assert.ok(checked.ok);
      const result = resolveDatabaseChannel(checked.value, context);
      assert.equal(result.ok, false);
      assert.equal(JSON.stringify(result).includes(url), false);
    }
    env.PULSE_NOTIFY_SECRET_HOOK = "http://127.0.0.1/hook";
    const checked = validateNotifyChannelRecord({ ...record, type });
    assert.ok(checked.ok);
    assert.equal(resolveDatabaseChannel(checked.value, context).ok, true);
  }
  const checked = validateNotifyChannelRecord({
    id: "mail",
    type: "email",
    createdAt: 1,
    updatedAt: 2,
    smtp: {
      host: "smtp.invalid",
      port: 25,
      tls: "none",
      username: "u",
      passwordEnv: "PULSE_NOTIFY_SECRET_PASSWORD",
    },
    from: "a@example.org",
    to: ["b@example.org"],
  });
  assert.ok(checked.ok);
  const result = resolveDatabaseChannel(checked.value, context);
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes(MARKER), false);
});
