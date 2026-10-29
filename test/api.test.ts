import assert from "node:assert/strict";
import { test } from "node:test";
import { WIRE_VERSION, WIRE_VERSION_HEADER } from "@lorenzh/pulse-contract";
import { fetchChecks, fetchIncidents } from "../src/api.ts";
import { httpCheck, incident } from "./support.ts";

async function check(over: Record<string, unknown>) {
  const body = [{ ...incident({ id: 1 }), ...over }];
  const fake: typeof fetch = async () => new Response(JSON.stringify(body), { status: 200 });
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
  return async () => new Response(JSON.stringify(body), { status: 200, headers });
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
