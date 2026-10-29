import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchIncidents } from "../src/api.ts";
import { incident } from "./support.ts";

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
