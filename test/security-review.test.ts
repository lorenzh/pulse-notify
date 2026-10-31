import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { validateCheck, validateIncident, validateManualIncident } from "@lorenzh/pulse-contract";
import { fetchChecks, fetchIncidents, fetchManualIncidents } from "../src/api.ts";
import { Ledger } from "../src/ledger.ts";
import { Notifier } from "../src/notifier.ts";
import {
  close,
  fakeFetch,
  httpCheck,
  incident,
  listen,
  manualIncident,
  spyLogger,
  startFakeApi,
} from "./support.ts";

const MARKER = "PULSE_SECURITY_RESPONSE_MARKER";
const readers = [fetchIncidents, fetchChecks, fetchManualIncidents];

test("security: every feed drops response markers across failure categories", async () => {
  const dir = mkdtempSync(join(tmpdir(), "notify-security-"));
  const cases = [
    { status: 200, body: MARKER, headers: {} },
    { status: 200, body: `{"x":${MARKER}`, headers: {} },
    { status: 200, body: JSON.stringify({ [MARKER]: MARKER }), headers: {} },
    { status: 200, body: "[]", headers: { "x-pulse-contract": MARKER } },
    { status: 500, body: MARKER, headers: { "x-pulse-contract": MARKER } },
    { status: 302, body: MARKER, headers: { location: `/${MARKER}` } },
    { status: 200, body: MARKER.repeat(100), headers: {} },
    {
      status: 200,
      body: `[{"id":"${MARKER}"},null,[],{"id":{"toString":null,"valueOf":null}}]`,
      headers: {},
    },
  ];
  let selected = cases[0];
  const server = createServer((_req, res) => {
    assert.ok(selected);
    res.writeHead(selected.status, selected.headers);
    res.end(selected.body);
  });
  const url = await listen(server);
  try {
    for (const answer of cases) {
      selected = answer;
      const logger = spyLogger();
      const n = new Notifier({
        config: { channels: [] },
        apiUrl: url,
        apiMaxBytes: 512,
        ledger: new Ledger(join(dir, "state.json")),
        logger,
        now: () => 1000,
        schedule: () => () => {},
      });
      try {
        await n.tick();
        assert.ok(logger.entries.length > 0);
        assert.equal(JSON.stringify(logger.entries).includes(MARKER), false);
      } finally {
        await n.stop();
      }
    }
    console.log("security markers: 8 cases x 3 feeds, zero marker leaks");
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("security: raw HTTP parsing and decompression errors drop server text", async () => {
  const replies = [
    `${MARKER}\r\n\r\n`,
    `HTTP/1.1 200 ${MARKER}\r\nContent-Length: ${MARKER.length}\r\nConnection: close\r\n\r\n${MARKER}`,
    `HTTP/1.1 200 OK\r\n${MARKER}: bad\x00value\r\nContent-Length: 2\r\n\r\n[]`,
    `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${MARKER}\r\n`,
    `HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: ${MARKER.length}\r\nConnection: close\r\n\r\n${MARKER}`,
  ];
  for (const reply of replies) {
    const server = createTcpServer((socket) => {
      socket.once("data", () => socket.end(reply));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    try {
      for (const read of readers) {
        const error: unknown = await read({ baseUrl: `http://127.0.0.1:${address.port}` }).catch(
          (e: unknown) => e,
        );
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes(MARKER), false, error.message);
        assert.equal(error.cause, undefined);
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  }
  console.log("security raw transport: 5 replies x 3 feeds, zero marker leaks");
});

test("security: compressed and chunked oversized bodies fail on all feeds", async () => {
  const expanded = JSON.stringify(["x".repeat(10000)]);
  const compressed = gzipSync(expanded);
  let isCompressed = true;
  const server = createServer((_req, res) => {
    if (isCompressed) {
      res.writeHead(200, { "content-encoding": "gzip", "content-length": compressed.length });
      res.end(compressed);
    } else {
      res.writeHead(200, { "transfer-encoding": "chunked" });
      res.write(expanded.slice(0, 600));
      res.end(expanded.slice(600));
    }
  });
  const url = await listen(server);
  try {
    for (const compressedCase of [true, false]) {
      isCompressed = compressedCase;
      for (const read of readers) {
        await assert.rejects(read({ baseUrl: url, maxBytes: 512 }), /larger than 512 bytes/);
      }
    }
    console.log("security limits: gzip and chunked x 3 feeds rejected above 512 decoded bytes");
  } finally {
    await close(server);
  }
});

test("security: timeout abort signal and accept header survive the redirect wrapper", async () => {
  for (const read of readers) {
    let timeout: (() => void) | undefined;
    let observed: RequestInit | undefined;
    const result = read({
      baseUrl: "https://127.0.0.1:1",
      timeoutMs: 123,
      schedule: (fn) => {
        timeout = fn;
        return () => {};
      },
      fetch: fakeFetch(async (_input, init) => {
        observed = init;
        return new Promise<Response>(() => {});
      }),
    });
    assert.equal(observed?.redirect, "manual");
    assert.equal(new Headers(observed?.headers).get("accept"), "application/json");
    assert.ok(timeout);
    timeout();
    await assert.rejects(result, /timeout after 123ms/);
    assert.equal(observed?.signal?.aborted, true);
  }
  console.log("security timeout: 3 feeds preserve headers and abort on injected timeout");
});

test("security: all redirect status codes stay local and do not reach the target", async () => {
  let targetHits = 0;
  const target = createServer((_req, res) => {
    targetHits++;
    res.end("[]");
  });
  const targetUrl = await listen(target);
  let status = 301;
  const origin = createServer((_req, res) => {
    res.writeHead(status, { location: `${targetUrl}/${MARKER}`, authorization: MARKER });
    res.end(MARKER);
  });
  const originUrl = await listen(origin);
  try {
    for (const code of [301, 302, 303, 307, 308]) {
      status = code;
      for (const read of readers) {
        await assert.rejects(read({ baseUrl: originUrl }), new RegExp(`returned ${code}$`));
      }
    }
    assert.equal(targetHits, 0);
    for (const read of readers) {
      let requests = 0;
      await assert.rejects(
        read({
          baseUrl: "https://127.0.0.1:1",
          fetch: fakeFetch(async (_input, init) => {
            requests++;
            assert.equal(init?.redirect, "manual");
            return new Response(null, { status: 302, headers: { location: targetUrl } });
          }),
        }),
        /returned 302/,
      );
      assert.equal(requests, 1);
    }
    console.log(
      "security redirects: 5 codes x 3 feeds, target requests 0; HTTPS downgrade requests 0",
    );
  } finally {
    await close(origin);
    await close(target);
  }
});

test("security: validators reject hostile values and never invoke accessors", () => {
  let calls = 0;
  const getter = (): never => {
    calls++;
    throw new Error(MARKER);
  };
  const fixtures = [
    { validate: validateIncident, value: incident({ id: 1 }) },
    { validate: validateCheck, value: httpCheck("a", "A") },
    { validate: validateManualIncident, value: manualIncident({ id: 1 }) },
  ];
  let probes = 0;
  for (const { validate, value } of fixtures) {
    for (const raw of [null, true, 42, MARKER, [], { id: null }, { id: "x".repeat(100000) }]) {
      assert.equal(validate(raw).ok, false);
      probes++;
    }
    for (const key of ["id", "constructor", "__proto__", "toString"]) {
      const raw = { ...value };
      Object.defineProperty(raw, key, { get: getter, enumerable: true });
      assert.doesNotThrow(() => validate(raw));
      if (key === "id") assert.equal(validate(raw).ok, false);
      probes++;
    }
    const raw: unknown = new Proxy(
      {},
      { ownKeys: getter, getOwnPropertyDescriptor: getter, getPrototypeOf: getter },
    );
    assert.equal(validate(raw).ok, false);
    probes++;
  }
  // Proxy traps may be inspected but ordinary accessors must never run.
  assert.equal(calls, 3);
  calls = 0;
  const manual = manualIncident({ id: 1 });
  Object.defineProperty(manual.updates, "0", { get: getter });
  assert.equal(validateManualIncident(manual).ok, false);
  const check = httpCheck("a", "A");
  for (const control of ["\t", "\r", "\n"]) {
    assert.equal(validateCheck({ ...check, headers: { "x-test": `a${control}b` } }).ok, false);
  }
  assert.equal(validateCheck({ ...check, headers: { "x-test": "x".repeat(4097) } }).ok, false);
  assert.equal(
    validateCheck({ ...check, headers: { "x-test": { env: "INVALID\nENV" } } }).ok,
    false,
  );
  assert.equal(calls, 0);
  assert.equal(Object.hasOwn({}, MARKER), false);
  console.log(`security validators: ${probes + 6} hostile probes, zero accessor calls`);
});

test("security: exact image healthcheck rejects invalid env ports without fetching", async () => {
  const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  const match = /^ {2}CMD (\[.*\])$/m.exec(dockerfile);
  assert.ok(match?.[1]);
  const command: unknown = JSON.parse(match[1]);
  assert.ok(Array.isArray(command) && command.every((v: unknown) => typeof v === "string"));
  const script: unknown = command[2];
  assert.equal(typeof script, "string");
  if (typeof script !== "string") return;
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.end("ok");
  });
  const url = await listen(server);
  const localPort = new URL(url).port;
  try {
    for (const port of [
      `${localPort}@127.0.0.1:${localPort}/`,
      `${localPort}/../x`,
      "-1",
      "1e3",
      "123456",
      `${localPort}\t`,
      `${localPort}\r`,
      `${localPort}\n`,
      `${localPort}\r\n`,
      "１２３",
      "0x50",
    ]) {
      const child: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(
        [process.execPath, "-e", script],
        {
          env: { ...process.env, PULSE_HEALTH_PORT: port },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const code = await child.exited;
      const stderr: string = await new Response(child.stderr).text();
      assert.equal(code, 1, `port ${JSON.stringify(port)}: ${stderr}`);
      assert.equal(hits, 0);
    }
  } finally {
    await close(server);
  }
  console.log("security healthcheck: 11 invalid port values exit 1 with zero requests");
});

test("security: manual upgrade seed must not follow a pre-existing temporary-file symlink", async () => {
  const dir = mkdtempSync(join(tmpdir(), "notify-security-symlink-"));
  const state = join(dir, "state.json");
  const victim = join(dir, "unrelated-file.txt");
  writeFileSync(state, JSON.stringify({ version: 2, channels: { web: {} } }));
  writeFileSync(victim, "DO_NOT_OVERWRITE");
  symlinkSync(victim, `${state}.tmp`);
  const ledger = new Ledger(state, { now: () => 1000, schedule: () => () => {} });
  const api = await startFakeApi();
  api.manualIncidents = [manualIncident({ id: 7 })];
  const n = new Notifier({
    config: { channels: [{ id: "web", type: "file", path: join(dir, "notifications.jsonl") }] },
    apiUrl: api.url,
    ledger,
    logger: spyLogger(),
    now: () => 1000,
    schedule: () => () => {},
  });
  try {
    await n.tick();
    await n.idle();
    assert.equal(readFileSync(victim, "utf8"), "DO_NOT_OVERWRITE");
  } finally {
    await n.stop();
    ledger.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
