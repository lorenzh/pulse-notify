import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getService } from "../src/api.ts";
import { ChannelSync } from "../src/channel-sync.ts";
import { main } from "../src/index.ts";
import type { Schedule } from "../src/types.ts";
import { spyLogger } from "./support.ts";

const REVISION = `sha256-${"1".repeat(64)}`;

const OUTAGES: { name: string; answer: () => Promise<Response> }[] = [
  { name: "503", answer: () => Promise.resolve(new Response("unavailable", { status: 503 })) },
  { name: "500", answer: () => Promise.resolve(new Response("boom", { status: 500 })) },
  { name: "401", answer: () => Promise.resolve(new Response("no", { status: 401 })) },
  { name: "network error", answer: () => Promise.reject(new TypeError("connect refused")) },
];

for (const outage of OUTAGES) {
  test(`a failed channels read (${outage.name}) keeps the revision and reports one rejection`, async () => {
    let isDown = false;
    const serviceFetch: typeof fetch = Object.assign(
      () =>
        isDown
          ? outage.answer()
          : Promise.resolve(
              Response.json({ revision: REVISION, channels: [] }, { headers: { etag: '"r1"' } }),
            ),
      { preconnect: fetch.preconnect },
    );
    const sync = new ChannelSync({
      ledger: { remoteChannels: () => [], replaceRemoteChannels: () => {} },
      install: () => {},
      parseFile: () => [],
      fetchChannels: (etag) =>
        getService(
          { baseUrl: "http://127.0.0.1:1/", token: "review-token", fetch: serviceFetch },
          "service/notify/channels",
          (raw) => ({ ok: true, value: raw }),
          etag,
        ),
      secrets: { env: {}, secretDir: undefined, realpath: (p) => p, readFile: () => "" },
      now: () => 1_000,
      logger: spyLogger(),
    });
    await sync.poll();
    isDown = true;
    await sync.poll();
    assert.equal(sync.state().appliedRevision, REVISION);
    assert.deepEqual(sync.state().rejected, [
      { channelId: null, reason: "channels answer: api unreachable or failed" },
    ]);
  });
}

test("an API outage keeps the applied revision and reports the rejected poll", async () => {
  let isDown = false;
  const serviceFetch: typeof fetch = Object.assign(
    () =>
      Promise.resolve(
        isDown
          ? new Response("unavailable", { status: 503 })
          : Response.json({ revision: REVISION, channels: [] }, { headers: { etag: '"r1"' } }),
      ),
    { preconnect: fetch.preconnect },
  );
  const sync = new ChannelSync({
    ledger: { remoteChannels: () => [], replaceRemoteChannels: () => {} },
    install: () => {},
    parseFile: () => [],
    fetchChannels: (etag) =>
      getService(
        { baseUrl: "http://127.0.0.1:1/", token: "review-token", fetch: serviceFetch },
        "service/notify/channels",
        (raw) => ({ ok: true, value: raw }),
        etag,
      ),
    secrets: { env: {}, secretDir: undefined, realpath: (p) => p, readFile: () => "" },
    now: () => 1_000,
    logger: spyLogger(),
  });
  await sync.poll();
  isDown = true;
  await sync.poll();
  assert.equal(sync.state().appliedRevision, REVISION);
  assert.equal(sync.state().rejected.length, 1);
  assert.equal(sync.state().rejected[0]?.channelId, null);
});

test("shutdown waits for a heartbeat report that is already in flight", async () => {
  const dir = mkdtempSync(join(tmpdir(), "notify-review-heartbeat-"));
  const timers: { fn: () => void; ms: number; isCancelled: boolean }[] = [];
  const schedule: Schedule = (fn, ms) => {
    const timer = { fn, ms, isCancelled: false };
    timers.push(timer);
    return () => {
      timer.isCancelled = true;
    };
  };
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const serviceFetch: typeof fetch = Object.assign(
    () => {
      started.resolve();
      return response.promise;
    },
    { preconnect: fetch.preconnect },
  );
  const running = main(
    { PULSE_NOTIFY_API_TOKEN: "review-token", PULSE_NOTIFY_STATE: join(dir, "state.sqlite") },
    {
      logger: spyLogger(),
      now: () => 1_000,
      channelSchedule: schedule,
      heartbeatSchedule: () => () => {},
      serviceFetch,
      createNotifier: () => ({ start() {}, stop: () => Promise.resolve() }),
    },
  );
  try {
    await running.listening;
    const beat = timers.find((timer) => timer.ms === 60_000);
    assert.ok(beat);
    beat.fn();
    await started.promise;
    let isStopped = false;
    const stop = running.stop().then(() => {
      isStopped = true;
    });
    // Drain microtasks without allowing the fake HTTP response to finish.
    for (let i = 0; i < 50; i++) await Promise.resolve();
    const stoppedBeforeResponse = isStopped;
    response.resolve(new Response(null, { status: 204 }));
    await stop;
    assert.equal(stoppedBeforeResponse, false, "stop returned while its report was still sending");
  } finally {
    response.resolve(new Response(null, { status: 204 }));
    await running.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
