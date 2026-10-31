import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.ts";
import { Metrics } from "../src/metrics.ts";
import { Notifier } from "../src/notifier.ts";
import {
  asRecord,
  close,
  type FakeApi,
  fakeFetch,
  httpCheck,
  incident,
  listen,
  manualIncident,
  type SpyLogger,
  spyLogger,
  startFakeApi,
} from "./support.ts";

const MARKER = "PULSE_MARKER_7f3a";

let api: FakeApi;
let dir: string;
let logger: SpyLogger;
let metrics: Metrics;

beforeEach(async () => {
  api = await startFakeApi();
  dir = mkdtempSync(join(tmpdir(), "notify-hostile-"));
  logger = spyLogger();
  metrics = new Metrics(["web"], () => 0);
});
afterEach(async () => {
  await api.close();
  rmSync(dir, { recursive: true, force: true });
});

const outPath = (): string => join(dir, "web.jsonl");

function make(fetchFn?: typeof fetch): Notifier {
  return new Notifier({
    config: { channels: [{ id: "web", type: "file", path: outPath() }] },
    apiUrl: api.url,
    ledger: new Ledger(join(dir, "state.json")),
    logger,
    metrics,
    fetch: fetchFn,
    sleep: async () => {},
    schedule: () => () => {},
  });
}

async function poll(n: Notifier): Promise<void> {
  await n.tick();
  await n.idle();
}

function sent(): Record<string, unknown>[] {
  try {
    return readFileSync(outPath(), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => asRecord(JSON.parse(l)));
  } catch {
    // No file means nothing was delivered.
    return [];
  }
}

const json = (body: string) => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body,
});

/** A started notifier whose channel is seeded on empty feeds, so later items are new. */
async function seeded(fetchFn?: typeof fetch): Promise<Notifier> {
  const n = make(fetchFn);
  await poll(n);
  return n;
}

const hostileId = '{"toString":null,"valueOf":null}';

test("a malformed incident id does not stop the next incident", async () => {
  const n = await seeded();
  const valid = JSON.stringify(incident({ id: 42 }));
  api.raw.set(
    "/incidents",
    json(
      `[{"id":${hostileId},"checkId":"a","openedAt":1,"resolvedAt":null},{"id":{"a":{"b":1}}},${valid}]`,
    ),
  );
  await poll(n);
  await n.stop();
  assert.deepEqual(
    sent().map((e) => e.key),
    ["42:opened"],
  );
  assert.equal(logger.entries.filter((e) => e.msg === "poll failed unexpectedly").length, 0);
  const skips = logger.entries.filter((e) => e.msg === "incident skipped: malformed data");
  assert.deepEqual(
    skips.map((e) => e.fields),
    [
      { feed: "incidents", index: 0, reason: "invalid" },
      { feed: "incidents", index: 1, reason: "invalid" },
    ],
  );
});

test("a malformed manual incident and check do not stop the rest of the poll", async () => {
  const n = await seeded();
  api.incidents = [incident({ id: 3 })];
  api.raw.set(
    "/manual-incidents",
    json(`[{"id":${hostileId}},${JSON.stringify(manualIncident({ id: 9 }))}]`),
  );
  api.raw.set(
    "/checks",
    json(`[{"id":${hostileId}},${JSON.stringify(httpCheck("example", "Example site"))}]`),
  );
  await poll(n);
  await n.stop();
  const keys = sent().map((e) => e.key);
  assert.deepEqual(new Set(keys), new Set(["3:opened", "manual:9:opened"]));
  assert.equal(sent().find((e) => e.key === "3:opened")?.checkName, "Example site");
  assert.deepEqual(logger.entries.find((e) => e.msg === "check skipped: malformed data")?.fields, {
    feed: "checks",
    index: 0,
    reason: "invalid",
  });
  assert.deepEqual(
    logger.entries.find((e) => e.msg === "incident skipped: malformed data")?.fields,
    { feed: "manual-incidents", index: 0, reason: "invalid" },
  );
});

test("a skipped item is counted on every poll and logged once", async () => {
  const n = make();
  api.raw.set("/incidents", json(`[{"id":5,"checkId":1}]`));
  await poll(n);
  await poll(n);
  await n.stop();
  assert.match(metrics.render(), /^pulse_notify_skipped_items_total\{feed="incidents"\} 2$/m);
  const skips = logger.entries.filter((e) => e.msg === "incident skipped: malformed data");
  assert.deepEqual(
    skips.map((e) => e.fields),
    [{ feed: "incidents", index: 0, reason: "invalid", incidentId: 5 }],
  );
});

const markerCases: [string, () => void][] = [
  ["a plain body", () => api.raw.set("/incidents", json(MARKER))],
  ["a broken object", () => api.raw.set("/incidents", json(`{"a": ${MARKER}`))],
  ["a 500 body", () => api.raw.set("/incidents", { status: 500, body: MARKER })],
  [
    "a wire header",
    () =>
      api.raw.set("/incidents", {
        status: 200,
        headers: { "content-type": "application/json", "x-pulse-contract": MARKER },
        body: "[]",
      }),
  ],
  ["a string id", () => api.raw.set("/incidents", json(`[{"id":"${MARKER}"}]`))],
  [
    "a check id",
    () => api.raw.set("/checks", json(`[{"id":"${MARKER}","name":"x","type":"nope"}]`)),
  ],
];

for (const [name, serve] of markerCases) {
  test(`api text never reaches a log line: ${name}`, async () => {
    serve();
    const n = make();
    await poll(n);
    await n.stop();
    assert.ok(logger.entries.length > 0);
    for (const entry of logger.entries) {
      assert.ok(!JSON.stringify(entry).includes(MARKER), JSON.stringify(entry));
    }
  });
}

test("no redirect is followed, cross-origin or same-origin", async () => {
  let hitsB = 0;
  const serverB = createServer((_req, res) => {
    hitsB++;
    res.setHeader("content-type", "application/json");
    res.end("[]");
  });
  const urlB = await listen(serverB);
  try {
    const n = await seeded();
    api.raw.set("/incidents", { status: 302, headers: { location: `${urlB}/incidents` } });
    api.raw.set("/checks", { status: 302, headers: { location: "/checks2" } });
    api.raw.set("/manual-incidents", { status: 302, headers: { location: `${urlB}/x` } });
    await poll(n);
    await n.stop();
    assert.equal(hitsB, 0);
    assert.equal(api.requested.includes("/checks2"), false);
    const text = metrics.render();
    for (const feed of ["incidents", "checks", "manual-incidents"]) {
      assert.match(text, new RegExp(`feed_polls_total\\{feed="${feed}",outcome="error"\\} 1`));
    }
    const failures = logger.entries.filter((e) => e.msg === "api poll failed");
    assert.ok(failures.every((e) => !JSON.stringify(e).includes(urlB)));
  } finally {
    await close(serverB);
  }
});

test("a redirect on one feed leaves the other feeds in use", async () => {
  const n = await seeded();
  api.raw.set("/incidents", { status: 302, headers: { location: "/elsewhere" } });
  api.manualIncidents = [manualIncident({ id: 9 })];
  await poll(n);
  await n.stop();
  assert.deepEqual(
    sent().map((e) => e.key),
    ["manual:9:opened"],
  );
});

test("every api read asks the fetch not to follow redirects", async () => {
  const seen: (string | undefined)[] = [];
  const recording = fakeFetch(async (input, init) => {
    seen.push(init?.redirect);
    return fetch(input, init);
  });
  const n = make(recording);
  await poll(n);
  await n.stop();
  assert.deepEqual(seen, ["manual", "manual", "manual"]);
});

test("the warning cache keeps 1024 identities and evicts the oldest", async () => {
  const items = (ids: number[]): string => JSON.stringify(ids.map((id) => ({ id, checkId: 1 })));
  const ids = Array.from({ length: 1025 }, (_, i) => i + 1);
  api.raw.set("/incidents", json(items(ids)));
  const n = make();
  await poll(n);
  const lines = (): number =>
    logger.entries.filter((e) => e.msg === "incident skipped: malformed data").length;
  assert.equal(lines(), 1025);
  api.raw.set("/incidents", json(items([2, 1])));
  await poll(n);
  await n.stop();
  assert.equal(lines(), 1026);
  assert.match(metrics.render(), /^pulse_notify_skipped_items_total\{feed="incidents"\} 1027$/m);
});
