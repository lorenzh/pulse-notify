import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Ledger } from "../src/ledger.ts";
import { Notifier } from "../src/notifier.ts";
import type { ChannelConfig, Schedule, Sleep } from "../src/types.ts";
import {
  asRecord,
  type FakeApi,
  httpCheck,
  incident,
  type Receiver,
  type SpyLogger,
  spyLogger,
  startFakeApi,
  startReceiver,
} from "./support.ts";

let api: FakeApi;
let rx: Receiver;
let dir: string;
let logger: SpyLogger;

beforeEach(async () => {
  api = await startFakeApi();
  rx = await startReceiver();
  dir = mkdtempSync(join(tmpdir(), "notify-e2e-"));
  logger = spyLogger();
  api.checks = [httpCheck("example", "Example site"), httpCheck("other", "Other")];
});

afterEach(async () => {
  await api.close();
  await rx.close();
});

const statePath = () => join(dir, "state.json");
const filePath = () => join(dir, "out", "incidents.jsonl");

function channels(extra: Partial<ChannelConfig>[] = []): ChannelConfig[] {
  return [
    { id: "hook", type: "webhook", url: rx.url },
    { id: "log", type: "file", path: filePath() },
    ...(extra as ChannelConfig[]),
  ];
}

function make(
  opts: {
    channels?: ChannelConfig[];
    sleep?: Sleep;
    schedule?: Schedule;
    retryAttempts?: number;
    fetch?: typeof fetch;
    timeoutMs?: number;
  } = {},
) {
  return new Notifier({
    config: { channels: opts.channels ?? channels() },
    apiUrl: api.url,
    ledger: new Ledger(statePath()),
    logger,
    retryDelayMs: 1000,
    retryAttempts: opts.retryAttempts,
    fetch: opts.fetch,
    timeoutMs: opts.timeoutMs,
    sleep: opts.sleep ?? (async () => {}),
    schedule: opts.schedule ?? (() => () => {}),
  });
}

function lines(): Record<string, unknown>[] {
  try {
    return readFileSync(filePath(), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => asRecord(JSON.parse(l)));
  } catch {
    // No ledger file yet means nothing has been delivered.
    return [];
  }
}

/** Notifier that seeds an empty ledger first, so later incidents count as new. */
async function started(opts: Parameters<typeof make>[0] = {}) {
  const n = make(opts);
  await n.tick();
  return n;
}

test("opened and resolved are delivered once each despite an outage; restart sends nothing", async () => {
  const sleeps: number[] = [];
  const n = await started({
    sleep: async (ms) => {
      sleeps.push(ms);
      if (sleeps.length === 2) rx.up = true;
    },
  });

  // 1. receiver off, incident opens
  rx.up = false;
  api.incidents = [incident({ id: 1, openedAt: Date.UTC(2026, 0, 1, 12, 0, 0) })];
  await n.tick();
  await n.idle();
  assert.deepEqual(sleeps, [1000, 2000]);
  assert.equal(rx.requests.length, 3);
  assert.equal(rx.accepted().length, 1);
  const expectedOpened = {
    key: "1:opened",
    event: "opened",
    incidentId: 1,
    checkId: "example",
    checkName: "Example site",
    reason: "HTTP 503",
    time: "2026-01-01T12:00:00.000Z",
    timeMs: Date.UTC(2026, 0, 1, 12, 0, 0),
  };
  assert.deepEqual(rx.accepted()[0]?.body, expectedOpened);
  assert.equal(rx.accepted()[0]?.headers["idempotency-key"], "1:opened");
  assert.deepEqual(lines(), [expectedOpened]);

  // 2. incident resolves, same off/on sequence
  rx.up = false;
  sleeps.length = 0;
  const resolvedAt = Date.UTC(2026, 0, 1, 12, 5, 0);
  api.incidents = [incident({ id: 1, resolvedAt })];
  await n.tick();
  await n.idle();
  assert.equal(rx.accepted().length, 2);
  const resolved = asRecord(rx.accepted()[1]?.body);
  assert.equal(resolved.key, "1:resolved");
  assert.equal(resolved.event, "resolved");
  assert.equal(resolved.time, "2026-01-01T12:05:00.000Z");
  assert.equal(resolved.reason, "HTTP 503");
  assert.deepEqual(
    lines().map((l) => l.event),
    ["opened", "resolved"],
  );
  assert.deepEqual(lines()[1], resolved);

  // repeated ticks do not duplicate
  await n.tick();
  await n.idle();
  assert.equal(rx.accepted().length, 2);

  // 3. restart: same ledger, config and api data
  const before = rx.requests.length;
  const again = make({ retryAttempts: 4 });
  await again.tick();
  await again.idle();
  assert.equal(rx.requests.length, before);
  assert.equal(lines().length, 2);
});

test("a permanently down channel logs after 4 attempts and does not delay the healthy one", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let sleeping = 0;
  const n = await started({
    retryAttempts: 4,
    sleep: async () => {
      sleeping++;
      await gate;
    },
  });
  rx.up = false;
  api.incidents = [incident({ id: 1 })];
  await n.tick(); // returns although the webhook is retrying
  await logger.waitFor((e) => e.msg === "notification delivered" && e.fields.channel === "log");
  assert.equal(lines().length, 1);
  assert.equal(sleeping, 1); // the webhook worker is parked in its first retry wait
  assert.equal(
    logger.entries.some((e) => e.level === "error"),
    false,
  );

  release();
  await n.idle();
  assert.equal(rx.requests.length, 4);
  assert.equal(rx.accepted().length, 0);
  const err = logger.entries.find((e) => e.level === "error");
  assert.equal(err?.fields.channel, "hook");
  assert.equal(err?.fields.key, "1:opened");
  assert.equal(err?.fields.attempts, 4);

  // failed events are not retried later, nor after a restart
  await n.tick();
  await n.idle();
  const again = make();
  await again.tick();
  await again.idle();
  assert.equal(rx.requests.length, 4);
});

test("a resolved event is sent even when opened failed", async () => {
  const n = await started();
  rx.up = false;
  api.incidents = [incident({ id: 1 })];
  await n.tick();
  await n.idle();
  rx.up = true;
  api.incidents = [incident({ id: 1, resolvedAt: Date.UTC(2026, 0, 1, 13) })];
  await n.tick();
  await n.idle();
  assert.deepEqual(
    rx.accepted().map((r) => asRecord(r.body).key),
    ["1:resolved"],
  );
});

test("an incident opened and resolved between polls yields opened then resolved", async () => {
  const n = await started();
  api.incidents = [incident({ id: 1, resolvedAt: Date.UTC(2026, 0, 1, 12, 1) })];
  await n.tick();
  await n.idle();
  assert.deepEqual(
    rx.accepted().map((r) => asRecord(r.body).key),
    ["1:opened", "1:resolved"],
  );
});

test("a channel filtered to another check receives nothing", async () => {
  const n = await started({
    channels: [
      { id: "hook", type: "webhook", url: rx.url, checks: ["other"] },
      { id: "log", type: "file", path: filePath(), checks: ["example", "later"] },
    ],
  });
  api.incidents = [incident({ id: 1, checkId: "example" })];
  await n.tick();
  await n.idle();
  assert.equal(rx.requests.length, 0);
  assert.equal(lines().length, 1);
});

test("an empty checks list means all checks; unknown check name falls back to the id", async () => {
  const n = await started({ channels: [{ id: "hook", type: "webhook", url: rx.url, checks: [] }] });
  api.incidents = [incident({ id: 1, checkId: "ghost", reason: null })];
  await n.tick();
  await n.idle();
  assert.equal(asRecord(rx.accepted()[0]?.body).checkName, "ghost");
  assert.equal(asRecord(rx.accepted()[0]?.body).reason, null);
});

test("first start with existing incidents sends nothing; later incidents are new", async () => {
  api.incidents = [incident({ id: 1 }), incident({ id: 2, resolvedAt: 5 })];
  const n = make();
  await n.tick();
  await n.idle();
  assert.equal(rx.requests.length, 0);
  assert.equal(lines().length, 0);

  // a seeded open incident resolving later is a new resolved event
  api.incidents = [
    incident({ id: 1, resolvedAt: Date.UTC(2026, 0, 2) }),
    incident({ id: 2, resolvedAt: 5 }),
    incident({ id: 3 }),
  ];
  await n.tick();
  await n.idle();
  assert.deepEqual(
    rx.accepted().map((r) => asRecord(r.body).key),
    ["1:resolved", "3:opened"],
  );
});

test("a channel seen for the first time is seeded without affecting existing ones", async () => {
  const n = await started();
  api.incidents = [incident({ id: 1 })];
  await n.tick();
  await n.idle();
  assert.equal(rx.accepted().length, 1);

  const second = make({
    channels: [...channels(), { id: "new", type: "file", path: join(dir, "new.jsonl") }],
  });
  await second.tick();
  await second.idle();
  assert.equal(rx.accepted().length, 1);
  assert.throws(() => readFileSync(join(dir, "new.jsonl")), /ENOENT/);
});

test("a failing api poll is logged and retried on the next tick", async () => {
  const n = await started();
  api.failing = true;
  api.incidents = [incident({ id: 1 })];
  await n.tick();
  await n.idle();
  assert.equal(
    logger.entries.some((e) => e.msg === "api poll failed"),
    true,
  );
  assert.equal(rx.requests.length, 0);
  api.failing = false;
  await n.tick();
  await n.idle();
  assert.equal(rx.accepted().length, 1);
});

test("start schedules polls through the injected scheduler; stop cancels", async () => {
  const scheduled: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const n = make({
    schedule: (fn, ms) => {
      const entry = { fn, ms, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  });
  n.start();
  const poll = scheduled.at(-1);
  assert.equal(poll?.ms, 0);
  poll?.fn();
  await n.tick();
  await n.idle();
  await new Promise((r) => setImmediate(r));
  const next = scheduled.filter((s) => s.ms === 5000 && !s.cancelled).at(-1);
  assert.ok(next, "next poll scheduled after pollMs");
  await n.stop();
  assert.equal(next?.cancelled, true);
});

function unhandledRejections(): { seen: unknown[]; stop: () => void } {
  const seen: unknown[] = [];
  const listener = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on("unhandledRejection", listener);
  return { seen, stop: () => process.off("unhandledRejection", listener) };
}

const tick = () => new Promise((r) => setImmediate(r));

test("restart resends a pending notification from the ledger once", async () => {
  const note = {
    key: "1:opened",
    event: "opened" as const,
    incidentId: 1,
    checkId: "example",
    checkName: "Example site",
    reason: "HTTP 503",
    time: "2026-01-01T12:00:00.000Z",
    timeMs: Date.UTC(2026, 0, 1, 12, 0, 0),
  };
  const ledger = new Ledger(statePath());
  ledger.seed("hook", []);
  ledger.seed("log", []);
  ledger.claim("hook", "1:opened", note);
  api.incidents = [incident({ id: 1 })];

  const n = make();
  n.start();
  await n.tick();
  await n.idle();
  await n.stop();
  assert.equal(rx.accepted().length, 1);
  assert.deepEqual(rx.accepted()[0]?.body, note);
  assert.equal(new Ledger(statePath()).status("hook", "1:opened"), "delivered");
  assert.equal(
    logger.entries.some((e) => e.msg === "resending pending notifications" && e.fields.count === 1),
    true,
  );
});

test("a legacy pending key without payload is rebuilt from the API", async () => {
  const ledger = new Ledger(statePath());
  ledger.seed("hook", []);
  ledger.seed("log", []);
  writeFileSync(
    statePath(),
    JSON.stringify({
      version: 1,
      channels: { hook: { "1:opened": "pending", "7:opened": "pending" }, log: {} },
    }),
  );
  api.incidents = [incident({ id: 1 })];
  const n = make();
  n.start();
  await n.tick();
  await n.idle();
  await n.tick();
  await n.idle();
  await n.stop();
  assert.equal(rx.accepted().length, 1);
  assert.equal(rx.accepted()[0]?.headers["idempotency-key"], "1:opened");
  const missing = logger.entries.filter((e) => e.msg.includes("cannot be rebuilt"));
  assert.equal(missing.length, 1);
  assert.equal(missing[0]?.fields.key, "7:opened");
  assert.equal(new Ledger(statePath()).status("hook", "7:opened"), "pending");
});

test("stop during an outage keeps the key pending; the next start delivers it", async () => {
  const sleeping = Promise.withResolvers<void>();
  const n = await started({
    sleep: (_ms, signal) =>
      new Promise((resolve) => {
        sleeping.resolve();
        signal?.addEventListener("abort", () => resolve());
      }),
  });
  rx.up = false;
  api.incidents = [incident({ id: 1 })];
  await n.tick();
  await sleeping.promise;
  await n.stop();
  const before = rx.requests.length;
  assert.equal(new Ledger(statePath()).status("hook", "1:opened"), "pending");

  rx.up = true;
  const again = make();
  again.start();
  await again.tick();
  await again.idle();
  await again.stop();
  assert.equal(rx.accepted().filter((r) => r.headers["idempotency-key"] === "1:opened").length, 1);
  assert.ok(rx.requests.length > before);
});

test("a malformed incident is logged once; the others are delivered", async () => {
  const rejections = unhandledRejections();
  const n = await started();
  api.incidents = [
    incident({ id: 1, openedAt: Number.NaN }),
    { ...incident({ id: 2 }), openedAt: "yesterday" } as never,
    incident({ id: 3 }),
  ];
  await n.tick();
  await n.idle();
  await n.tick();
  await n.idle();
  await tick();
  rejections.stop();
  assert.deepEqual(rejections.seen, []);
  const bad = logger.entries.filter((e) => e.msg === "incident skipped: malformed data");
  assert.equal(bad.length, 2); // ids 1 and 2, once each over two polls
  const accepted = rx.accepted().map((r) => r.headers["idempotency-key"]);
  assert.deepEqual(accepted, ["3:opened"]);
});

test("a stalled api body times out, is logged, and the next poll runs", async () => {
  let calls = 0;
  let timer: (() => void) | undefined;
  const stalled: typeof fetch = async () => {
    calls++;
    return new Response(new ReadableStream({ start() {} }), { status: 200 });
  };
  const n = make({
    fetch: stalled,
    timeoutMs: 50,
    schedule: (fn) => {
      timer = fn;
      return () => {};
    },
  });
  const polling = n.tick();
  await tick();
  timer?.();
  await polling;
  const failed = logger.entries.find((e) => e.msg === "api poll failed");
  assert.equal(failed?.fields.error, "timeout after 50ms");
  const first = calls;
  const second = n.tick();
  await tick();
  timer?.();
  await second;
  assert.ok(calls > first);
});

test("throwing ledger claim, settle and seed are logged without rejection", async () => {
  const rejections = unhandledRejections();
  const ledger = new Ledger(statePath());
  const n = new Notifier({
    config: { channels: [{ id: "log", type: "file", path: filePath() }] },
    apiUrl: api.url,
    ledger,
    logger,
    sleep: async () => {},
    schedule: () => () => {},
  });
  const realSeed = ledger.seed.bind(ledger);
  ledger.seed = () => {
    throw new Error("seed io");
  };
  await n.tick();
  assert.equal(ledger.hasChannel("log"), false);
  assert.ok(logger.entries.some((e) => e.msg.startsWith("ledger seed failed")));
  ledger.seed = realSeed;
  await n.tick();
  assert.equal(ledger.hasChannel("log"), true);

  const realClaim = ledger.claim.bind(ledger);
  ledger.claim = () => {
    throw new Error("claim io");
  };
  api.incidents = [incident({ id: 1 })];
  await n.tick();
  await n.idle();
  assert.equal(lines().length, 0);
  ledger.claim = realClaim;
  await n.tick(); // the key was released, so the next poll retries it
  await n.idle();
  assert.equal(lines().length, 1);

  const realSettle = ledger.settle.bind(ledger);
  ledger.settle = () => {
    throw new Error("settle io");
  };
  api.incidents = [incident({ id: 1 }), incident({ id: 2 })];
  await n.tick();
  await n.idle();
  assert.equal(ledger.status("log", "2:opened"), "pending");
  ledger.settle = realSettle;
  await tick();
  rejections.stop();
  assert.deepEqual(rejections.seen, []);
});

test("an out-of-range timestamp does not keep the event queued", async () => {
  const rejections = unhandledRejections();
  const n = await started();
  api.incidents = [incident({ id: 1, openedAt: 1.8e18 }), incident({ id: 2 })];
  await n.tick();
  await n.idle();
  await tick();
  const bad = logger.entries.filter((e) => e.msg === "incident skipped: malformed data");
  assert.equal(bad.length, 1);
  assert.equal(bad[0]?.fields?.incidentId, 1);
  assert.deepEqual(
    rx.accepted().map((r) => r.headers["idempotency-key"]),
    ["2:opened"],
  );

  api.incidents = [incident({ id: 1 }), incident({ id: 2 })];
  await n.tick();
  await n.idle();
  await tick();
  rejections.stop();
  assert.deepEqual(rejections.seen, []);
  assert.deepEqual(
    rx.accepted().map((r) => r.headers["idempotency-key"]),
    ["2:opened", "1:opened"],
  );
});

/**
 * Fetch that makes `reason` of the listed incident ids throw, but only while the notification is
 * built. Validation and detection read the incident normally, so the fault hits only the build.
 */
function buildFault(poisoned: Set<number>): typeof fetch {
  return async (input, init) => {
    const res = await fetch(input, init);
    if (!String(input).endsWith("/incidents")) return res;
    const items: unknown = await res.json();
    if (!Array.isArray(items)) return res;
    for (const item of items) {
      if (typeof item !== "object" || item === null) continue;
      const { id, reason } = item as { id?: unknown; reason?: unknown };
      if (typeof id !== "number" || !poisoned.has(id)) continue;
      Object.defineProperty(item, "reason", {
        get() {
          if (poisoned.has(id) && new Error().stack?.includes("buildNotification")) {
            throw new Error("injected build fault");
          }
          return reason;
        },
      });
    }
    return Object.defineProperty(res, "json", { value: async () => items });
  };
}

function builtFailures(): { channel: unknown; key: unknown; error: unknown }[] {
  return logger.entries
    .filter((e) => e.msg === "notification cannot be built, the next poll retries")
    .map((e) => ({ channel: e.fields.channel, key: e.fields.key, error: e.fields.error }));
}

test("a build error is logged per channel, leaves the key unqueued and other events deliver", async () => {
  const poisoned = new Set([1]);
  const n = await started({ fetch: buildFault(poisoned) });
  api.incidents = [incident({ id: 1 }), incident({ id: 2 })];
  await n.tick();
  await n.idle();
  await tick();
  assert.deepEqual(
    builtFailures().sort((a, b) => String(a.channel).localeCompare(String(b.channel))),
    [
      { channel: "hook", key: "1:opened", error: "injected build fault" },
      { channel: "log", key: "1:opened", error: "injected build fault" },
    ],
  );
  assert.deepEqual(
    rx.accepted().map((r) => r.headers["idempotency-key"]),
    ["2:opened"],
  );
  assert.deepEqual(
    lines().map((l) => l.key),
    ["2:opened"],
  );
  assert.equal(new Ledger(statePath()).has("hook", "1:opened"), false);

  poisoned.clear();
  await n.tick();
  await n.idle();
  await tick();
  assert.deepEqual(
    rx.accepted().map((r) => r.headers["idempotency-key"]),
    ["2:opened", "1:opened"],
  );
  assert.deepEqual(
    lines().map((l) => l.key),
    ["2:opened", "1:opened"],
  );
});

test("a build error while rebuilding a legacy pending key is logged and retried", async () => {
  const ledger = new Ledger(statePath());
  ledger.seed("hook", []);
  ledger.seed("log", []);
  writeFileSync(
    statePath(),
    JSON.stringify({
      version: 1,
      channels: { hook: { "1:opened": "pending", "2:opened": "pending" }, log: {} },
    }),
  );
  api.incidents = [incident({ id: 1 }), incident({ id: 2 })];
  const poisoned = new Set([1]);
  const n = make({ fetch: buildFault(poisoned) });
  await n.tick();
  await n.idle();
  // The "log" channel is in the ledger too, so its normal enqueue fails for the same incident.
  assert.deepEqual(
    builtFailures().filter((f) => f.channel === "hook"),
    [{ channel: "hook", key: "1:opened", error: "injected build fault" }],
  );
  assert.deepEqual(
    rx.accepted().map((r) => r.headers["idempotency-key"]),
    ["2:opened"],
  );

  poisoned.clear();
  await n.tick();
  await n.idle();
  assert.deepEqual(
    rx.accepted().map((r) => r.headers["idempotency-key"]),
    ["2:opened", "1:opened"],
  );
});
