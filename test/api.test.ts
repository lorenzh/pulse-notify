import { test } from "bun:test";
import assert from "node:assert/strict";
import { WIRE_VERSION, WIRE_VERSION_HEADER } from "@lorenzh/pulse-contract";
import { fetchChecks, fetchIncidents } from "../src/api.ts";
import { fakeFetch, httpCheck, incident, startFakeApi } from "./support.ts";

async function check(over: Record<string, unknown>) {
  const body = [{ ...incident({ id: 1 }), ...over }];
  const fake = fakeFetch(async () => new Response(JSON.stringify(body), { status: 200 }));
  return fetchIncidents({ baseUrl: "http://127.0.0.1:1", fetch: fake });
}

test("openedAt and resolvedAt outside the Date range are rejected", async () => {
  for (const v of [1.8e18, -1.8e18, 8.64e15 + 1e3]) {
    const o = await check({ openedAt: v });
    assert.equal(o.incidents.length, 0);
    assert.equal(o.rejected[0]?.reason, "openedAt is not a valid date");
    const r = await check({ resolvedAt: v });
    assert.equal(r.incidents.length, 0);
    assert.equal(r.rejected[0]?.reason, "resolvedAt is not a valid date");
  }
});

test("the edges of the Date range are accepted", async () => {
  for (const v of [8.64e15, 0]) {
    assert.equal((await check({ openedAt: v })).incidents.length, 1);
    assert.equal((await check({ resolvedAt: v })).incidents.length, 1);
  }
});

const base = "http://127.0.0.1:1";

function respond(body: unknown, headers: Record<string, string> = {}): typeof fetch {
  return fakeFetch(async () => new Response(JSON.stringify(body), { status: 200, headers }));
}

test("an incident missing a required field is rejected with a path", async () => {
  const bad = { ...incident({ id: 1 }), checkId: undefined };
  const out = await fetchIncidents({ baseUrl: base, fetch: respond([bad, incident({ id: 2 })]) });
  assert.equal(out.incidents.length, 1);
  assert.match(out.rejected[0]?.reason ?? "", /^incidents\[0\]\.checkId: /);
});

test("a check missing a required field is skipped and reported", async () => {
  const errors: string[] = [];
  const checks = [httpCheck("a", "A"), { id: "b", name: "B" }];
  const out = await fetchChecks({
    baseUrl: base,
    fetch: respond(checks),
    onInvalidCheck: (e) => errors.push(e),
  });
  assert.deepEqual(
    out.map((c) => c.id),
    ["a"],
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", /^checks\[1\]\./);
});

test("a matching wire version is accepted without a report", async () => {
  let absent = 0;
  const out = await fetchIncidents({
    baseUrl: base,
    fetch: respond([], { [WIRE_VERSION_HEADER]: String(WIRE_VERSION) }),
    onVersionAbsent: () => absent++,
  });
  assert.deepEqual(out.incidents, []);
  assert.equal(absent, 0);
});

test("an absent wire version header is reported and the call continues", async () => {
  let absent = 0;
  await fetchChecks({ baseUrl: base, fetch: respond([]), onVersionAbsent: () => absent++ });
  assert.equal(absent, 1);
});

test("a wire version mismatch fails the call", async () => {
  const fetchFn = respond([], { [WIRE_VERSION_HEADER]: "999" });
  await assert.rejects(fetchIncidents({ baseUrl: base, fetch: fetchFn }), /wire version mismatch/);
  await assert.rejects(fetchChecks({ baseUrl: base, fetch: fetchFn }), /wire version mismatch/);
});

test("a check with an out-of-range value is skipped and reported", async () => {
  const errors: string[] = [];
  const out = await fetchChecks({
    baseUrl: base,
    fetch: respond([httpCheck("a", "A"), { ...httpCheck("b", "B"), retries: 11 }]),
    onInvalidCheck: (e) => errors.push(e),
  });
  assert.deepEqual(
    out.map((c) => c.id),
    ["a"],
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", /^checks\[1\]\./);
});

test("a non-2xx status wins over a wire version mismatch", async () => {
  const fetchFn = fakeFetch(
    async () => new Response("[]", { status: 503, headers: { [WIRE_VERSION_HEADER]: "999" } }),
  );
  await assert.rejects(
    fetchChecks({ baseUrl: base, fetch: fetchFn }),
    /^ApiReadError: GET checks returned 503$/,
  );
});

test("a body that is not an array fails the call", async () => {
  const fetchFn = fakeFetch(async () => new Response("{}", { status: 200 }));
  await assert.rejects(fetchChecks({ baseUrl: base, fetch: fetchFn }), /did not return an array/);
});

test("a stalled call times out through the injected schedule", async () => {
  const fetchFn = fakeFetch(() => new Promise<Response>(() => {}));
  const schedule = (fn: () => void): (() => void) => {
    queueMicrotask(fn);
    return () => {};
  };
  await assert.rejects(
    fetchChecks({ baseUrl: base, fetch: fetchFn, timeoutMs: 1234, schedule }),
    /^ApiReadError: timeout after 1234ms$/,
  );
});

test("a network error keeps its code and loses the credentials", async () => {
  const secretBase = "http://user:hunter2@127.0.0.1:1";
  const fetchFn = fakeFetch(async () => {
    throw Object.assign(new Error(`connect failed ${secretBase}/checks`), { code: "ECONNREFUSED" });
  });
  const err = await fetchChecks({ baseUrl: secretBase, fetch: fetchFn }).catch((e: unknown) => e);
  assert.ok(err instanceof Error);
  assert.equal((err as { code?: unknown }).code, "ECONNREFUSED");
  assert.ok(!err.message.includes("hunter2"));
});

test("checks with a url that is not http or https are dropped and reported", async () => {
  const api = await startFakeApi();
  try {
    api.checks = [
      httpCheck("plain", "Plain"),
      { id: "tls", name: "TLS", url: "https://example.invalid/check", intervalMs: 1000 },
      { id: "file", name: "File", url: "file:///tmp/dotenv-marker-556", intervalMs: 1000 },
      // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fixture URL is never requested
      { id: "ftp", name: "FTP", url: "ftp://example.invalid/check", intervalMs: 1000 },
    ];
    const errors: string[] = [];
    const out = await fetchChecks({ baseUrl: api.url, onInvalidCheck: (e) => errors.push(e) });
    assert.deepEqual(
      out.map((c) => c.id),
      ["plain", "tls"],
    );
    assert.equal(out.length, 2);
    assert.equal(errors.length, 2);
    assert.match(errors[0] ?? "", /^checks\[2\]\.url/);
    assert.match(errors[1] ?? "", /^checks\[3\]\.url/);
  } finally {
    await api.close();
  }
});
