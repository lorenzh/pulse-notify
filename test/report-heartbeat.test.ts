import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/index.ts";
import type { Schedule } from "../src/types.ts";
import { type SpyLogger, spyLogger } from "./support.ts";

const REVISION = `sha256-${"2".repeat(64)}`;

interface Timer {
  at: number;
  fn: () => void;
  isCancelled: boolean;
  isLoop: boolean;
}

/** A virtual clock with one timer queue; every timer and answer runs on it. */
class VirtualClock {
  time = 0;
  readonly timers: Timer[] = [];
  loopTimersAfterStop = 0;
  isStopCalled = false;

  readonly schedule: Schedule = (fn, ms) => this.add(fn, ms, true);

  add(fn: () => void, ms: number, isLoop: boolean): () => void {
    const timer: Timer = { at: this.time + ms, fn, isCancelled: false, isLoop };
    if (isLoop && this.isStopCalled) this.loopTimersAfterStop++;
    this.timers.push(timer);
    return () => {
      timer.isCancelled = true;
    };
  }

  /** Runs every timer due up to `until`, one event at a time, draining async work in between. */
  async advanceTo(until: number): Promise<void> {
    await drain();
    for (;;) {
      const due = this.timers
        .filter((t) => !t.isCancelled && t.at <= until)
        .sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.timers.splice(this.timers.indexOf(due), 1);
      this.time = due.at;
      due.fn();
      await drain();
    }
    this.time = until;
  }

  /** The loop timer that would fire at `at`, cancelled or not. */
  loopTimerAt(at: number): Timer | undefined {
    return this.timers.find((t) => t.isLoop && t.at === at);
  }
}

async function drain(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** How the fake API answers the report that starts at a time. */
type Answer = (start: number, clock: VirtualClock) => Promise<Response>;

const after =
  (ms: number): Answer =>
  (_start, clock) => {
    const done = new Response(null, { status: 204 });
    if (ms === 0) return Promise.resolve(done);
    return new Promise((resolve) => clock.add(() => resolve(done), ms, false));
  };

interface Harness {
  clock: VirtualClock;
  logger: SpyLogger;
  starts: number[];
  bodies: unknown[];
  maxConcurrency: () => number;
  stop: () => Promise<void>;
}

async function withService(
  pollMs: number,
  answer: Answer,
  body: (h: Harness) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "notify-report-heartbeat-"));
  const clock = new VirtualClock();
  const logger = spyLogger();
  const starts: number[] = [];
  const bodies: unknown[] = [];
  let active = 0;
  let maxActive = 0;
  const serviceFetch: typeof fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.includes("service/notify/report")) {
        return Promise.resolve(
          Response.json({ revision: REVISION, channels: [] }, { headers: { etag: '"r1"' } }),
        );
      }
      assert.equal(init?.method, "PUT");
      starts.push(clock.time);
      bodies.push(JSON.parse(String(init.body)));
      active++;
      maxActive = Math.max(maxActive, active);
      return answer(clock.time, clock).finally(() => {
        active--;
      });
    },
    { preconnect: fetch.preconnect },
  );
  const running = main(
    {
      PULSE_NOTIFY_API_TOKEN: "heartbeat-test-token",
      PULSE_NOTIFY_STATE: join(dir, "state.sqlite"),
      PULSE_NOTIFY_CHANNELS_POLL_MS: String(pollMs),
    },
    {
      logger,
      now: () => clock.time,
      channelSchedule: clock.schedule,
      heartbeatSchedule: () => () => {},
      commandSchedule: () => () => {},
      serviceFetch,
      createNotifier: () => ({ start() {}, stop: () => Promise.resolve() }),
    },
  );
  const stop = (): Promise<void> => {
    clock.isStopCalled = true;
    return running.stop();
  };
  try {
    await running.listening;
    await body({ clock, logger, starts, bodies, maxConcurrency: () => maxActive, stop });
  } finally {
    clock.isStopCalled = true;
    // Release any held answer so the stop can finish.
    await Promise.all([running.stop(), clock.advanceTo(10_000_000)]);
    rmSync(dir, { recursive: true, force: true });
  }
}

function largestGap(starts: readonly number[]): number {
  let gap = 0;
  for (let i = 1; i < starts.length; i++)
    gap = Math.max(gap, (starts[i] ?? 0) - (starts[i - 1] ?? 0));
  return gap;
}

test("1: with instant answers reports start every 60000 ms", async () => {
  await withService(300_000, after(0), async (h) => {
    await h.clock.advanceTo(180_000);
    assert.deepEqual(h.starts, [0, 60_000, 120_000, 180_000]);
    assert.equal(largestGap(h.starts), 60_000);
  });
});

test("2: a 4000 ms report does not stretch the heartbeat", async () => {
  await withService(300_000, after(4_000), async (h) => {
    await h.clock.advanceTo(180_000);
    assert.deepEqual(h.starts, [0, 60_000, 120_000, 180_000]);
    assert.ok(largestGap(h.starts) <= 60_000);
    assert.equal(h.maxConcurrency(), 1);
  });
});

test("3: a tick during a poll report waits for it, later ticks keep their cadence", async () => {
  await withService(53_000, after(4_000), async (h) => {
    await h.clock.advanceTo(180_000);
    assert.deepEqual(h.starts, [0, 57_000, 61_000, 114_000, 120_000, 171_000, 180_000]);
    assert.equal(h.maxConcurrency(), 1);
    assert.ok(largestGap(h.starts) <= 60_000);
  });
});

test("4: ticks during a held report are sent as one fresh report", async () => {
  const answer: Answer = (start, clock) =>
    start === 60_000 ? after(185_000 - start)(start, clock) : after(0)(start, clock);
  await withService(300_000, answer, async (h) => {
    await h.clock.advanceTo(240_000);
    assert.deepEqual(h.starts, [0, 60_000, 185_000, 240_000]);
    assert.equal(h.maxConcurrency(), 1);
    assert.equal((h.bodies[2] as { at?: unknown }).at, 185_000);
  });
});

const FAILURES: { name: string; answer: () => Promise<Response> }[] = [
  { name: "503", answer: () => Promise.resolve(new Response("unavailable", { status: 503 })) },
  { name: "TypeError", answer: () => Promise.reject(new TypeError("connect refused")) },
];

for (const failure of FAILURES) {
  test(`5: a failed report (${failure.name}) frees the slot`, async () => {
    const seen: unknown[] = [];
    const listener = (reason: unknown): void => {
      seen.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      const answer: Answer = (start, clock) =>
        start === 60_000 ? failure.answer() : after(0)(start, clock);
      await withService(300_000, answer, async (h) => {
        await h.clock.advanceTo(180_000);
        assert.deepEqual(h.starts, [0, 60_000, 120_000, 180_000]);
        assert.ok(h.logger.entries.some((e) => e.msg === "service report failed"));
      });
      await drain();
      assert.deepEqual(seen, []);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });
}

test("6: stop cancels the pending heartbeat", async () => {
  await withService(300_000, after(0), async (h) => {
    await h.clock.advanceTo(30_000);
    await h.stop();
    assert.equal(h.clock.loopTimerAt(60_000)?.isCancelled, true);
    await h.clock.advanceTo(600_000);
    assert.deepEqual(h.starts, [0]);
    assert.equal(h.clock.loopTimersAfterStop, 0);
  });
});

test("7: stop drops the waiting report and waits for the one in flight", async () => {
  const held = Promise.withResolvers<Response>();
  const answer: Answer = (start, clock) =>
    start === 60_000 ? held.promise : after(0)(start, clock);
  await withService(300_000, answer, async (h) => {
    await h.clock.advanceTo(120_000);
    await h.clock.advanceTo(130_000);
    let isStopped = false;
    const stopped = h.stop().then(() => {
      isStopped = true;
    });
    await drain();
    assert.equal(isStopped, false, "stop returned while a report was in flight");
    await h.clock.advanceTo(140_000);
    held.resolve(new Response(null, { status: 204 }));
    await stopped;
    assert.equal(h.clock.loopTimerAt(180_000)?.isCancelled, true);
    await h.clock.advanceTo(600_000);
    assert.deepEqual(h.starts, [0, 60_000]);
    assert.equal(h.maxConcurrency(), 1);
    assert.equal(h.clock.loopTimersAfterStop, 0);
  });
});
