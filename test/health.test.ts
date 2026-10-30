import { afterAll, afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type Stoppable } from "../src/index.ts";
import { Ledger } from "../src/ledger.ts";
import { Metrics } from "../src/metrics.ts";
import { Notifier } from "../src/notifier.ts";
import { type FakeApi, httpCheck, incident, spyLogger, startFakeApi } from "./support.ts";

const dir = mkdtempSync(join(tmpdir(), "notify-health-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const configPath = join(dir, "config.json");
writeFileSync(
  configPath,
  JSON.stringify({ channels: [{ id: "log", type: "file", path: join(dir, "o.jsonl") }] }),
);

let api: FakeApi;
beforeEach(async () => {
  api = await startFakeApi();
  api.checks = [httpCheck("example", "Example site")];
});
afterEach(() => api.close());

function notifier(fetchFn?: typeof fetch): Notifier {
  return new Notifier({
    config: { channels: [{ id: "log", type: "file", path: join(dir, "n.jsonl") }] },
    apiUrl: api.url,
    ledger: new Ledger(join(dir, "n-state.json")),
    logger: spyLogger(),
    fetch: fetchFn,
    schedule: () => () => {},
  });
}

test("consecutive failed polls count up and reset after one good poll", async () => {
  const n = notifier();
  assert.deepEqual(n.pollHealth(), { consecutiveFailedPolls: 0 });
  api.failing = true;
  await n.tick();
  await n.tick();
  assert.equal(n.pollHealth().consecutiveFailedPolls, 2);
  api.failing = false;
  await n.tick();
  assert.equal(n.pollHealth().consecutiveFailedPolls, 0);
});

test("a poll with rejected items is a good poll", async () => {
  const n = notifier();
  api.failing = true;
  await n.tick();
  api.failing = false;
  api.incidents = [{ nonsense: true } as never, incident({ id: 1 })];
  await n.tick();
  assert.equal(n.pollHealth().consecutiveFailedPolls, 0);
});

test("a detection error counts as a failed poll", async () => {
  const n = new Notifier({
    config: { channels: [{ id: "log", type: "file", path: join(dir, "d.jsonl") }] },
    apiUrl: api.url,
    ledger: {
      hasChannel() {
        throw new Error("boom");
      },
    } as unknown as Ledger,
    logger: spyLogger(),
    schedule: () => () => {},
  });
  await n.tick();
  assert.equal(n.pollHealth().consecutiveFailedPolls, 1);
});

test("the metric shows the consecutive failed polls", () => {
  let failed = 3;
  const metrics = new Metrics(
    ["a"],
    () => 0,
    () => failed,
  );
  assert.match(metrics.render(), /^pulse_notify_consecutive_failed_polls 3$/m);
  failed = 0;
  assert.match(metrics.render(), /^pulse_notify_consecutive_failed_polls 0$/m);
  assert.match(new Metrics([], () => 0).render(), /^pulse_notify_consecutive_failed_polls 0$/m);
});

test("/healthz is 200, then 503 after N failed polls, then 200 after one good poll", async () => {
  const running = main(
    {
      PULSE_NOTIFY_CONFIG: configPath,
      PULSE_NOTIFY_STATE: join(dir, "h-state.json"),
      PULSE_API_URL: api.url,
      PULSE_NOTIFY_POLL_MS: "10",
      PULSE_NOTIFY_HEALTH_MAX_FAILED_POLLS: "3",
      PULSE_HEALTH_PORT: "0",
    },
    { write: () => {} },
  );
  const port = await running.listening;
  const url = `http://127.0.0.1:${port}`;
  const until = async (check: (status: number, text: string) => boolean): Promise<string> => {
    for (let i = 0; i < 500; i++) {
      const res = await fetch(`${url}/healthz`);
      const text = await res.text();
      if (check(res.status, text)) return text;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timed out");
  };
  try {
    await until((status) => status === 200);
    api.failing = true;
    const text = await until((status) => status === 503);
    assert.match(text, /^polls failing \(\d+ in a row\)$/m);
    const metrics = await (await fetch(`${url}/metrics`)).text();
    assert.match(metrics, /^pulse_notify_consecutive_failed_polls [3-9]\d*$/m);
    api.failing = false;
    await until((status) => status === 200);
  } finally {
    await running.stop();
  }
});

test("the health check stays ok when the notifier has no pollHealth (test fakes)", async () => {
  const running = main(
    {
      PULSE_NOTIFY_CONFIG: configPath,
      PULSE_NOTIFY_STATE: join(dir, "h2-state.json"),
      PULSE_HEALTH_PORT: "0",
    },
    {
      write: () => {},
      createNotifier: (): Stoppable => ({ start() {}, async stop() {} }),
    },
  );
  const port = await running.listening;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
  } finally {
    await running.stop();
  }
});
