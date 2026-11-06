import { Database } from "bun:sqlite";
import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateNotifyServiceReport } from "@lorenzh/pulse-contract";
import { StartupError } from "@lorenzh/pulse-kit";
import { ConfigError } from "../src/config.ts";
import { main, run, type Stoppable } from "../src/index.ts";
import { Ledger } from "../src/ledger.ts";
import type { Schedule } from "../src/types.ts";
import { close, listen, startFakeApi, startReceiver } from "./support.ts";

const dir = mkdtempSync(join(tmpdir(), "notify-main-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fakeProc() {
  const handlers: Record<string, () => void> = {};
  const exits: number[] = [];
  const stderr: string[] = [];
  return {
    handlers,
    exits,
    stderr,
    proc: {
      on: (signal: "SIGINT" | "SIGTERM", fn: () => void) => {
        handlers[signal] = fn;
      },
      exit: (code: number) => {
        exits.push(code);
      },
      stderr: {
        write: (line: string) => {
          stderr.push(line);
        },
      },
    },
  };
}

async function setup(stop: () => Promise<void>, over: { lines?: string[] } = {}) {
  const configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ channels: [{ id: "log", type: "file", path: join(dir, "o.jsonl") }] }),
  );
  const fake = fakeProc();
  let boundTimer: { fn: () => void; ms: number } | undefined;
  await run(
    { PULSE_NOTIFY_CONFIG: configPath, PULSE_NOTIFY_STATE: join(dir, "state.json") },
    {
      proc: fake.proc,
      setTimeout: ((fn: () => void, ms: number) => {
        boundTimer = { fn, ms };
        return 0;
      }) as unknown as typeof setTimeout,
      clearTimeout: (() => {}) as typeof clearTimeout,
      main: {
        write: (line) => over.lines?.push(line),
        createNotifier: (): Stoppable => ({ start() {}, stop }),
      },
    },
  );
  return { ...fake, fireBound: () => boundTimer?.fn(), bound: () => boundTimer };
}

const flush = () => new Promise((r) => setImmediate(r));

test("SIGTERM exits with 0 only after stop resolved", async () => {
  const gate = Promise.withResolvers<void>();
  const { handlers, exits } = await setup(() => gate.promise);
  handlers.SIGTERM?.();
  await flush();
  assert.deepEqual(exits, []);
  gate.resolve();
  await flush();
  assert.deepEqual(exits, [0]);
});

test("a slow stop does not hang: the bound forces the exit", async () => {
  const { handlers, exits, fireBound } = await setup(() => new Promise(() => {}));
  handlers.SIGINT?.();
  await flush();
  assert.deepEqual(exits, []);
  fireBound();
  await flush();
  assert.deepEqual(exits, [1]);
});

test("signal handlers are registered before settings, config and ledger are read", async () => {
  const order: string[] = [];
  const fake = fakeProc();
  await run(
    {},
    {
      proc: {
        ...fake.proc,
        on: (signal, fn) => {
          order.push(signal);
          fake.proc.on(signal, fn);
        },
      },
    },
  );
  assert.deepEqual(order, ["SIGINT", "SIGTERM"]);
  assert.deepEqual(fake.exits, [2]);
  assert.deepEqual(fake.stderr, ["pulse-notify: PULSE_NOTIFY_CONFIG is required\n"]);
});

test("a second signal does nothing more", async () => {
  let stops = 0;
  const { handlers, exits } = await setup(async () => {
    stops++;
  });
  handlers.SIGTERM?.();
  handlers.SIGINT?.();
  await flush();
  assert.equal(stops, 1);
  assert.deepEqual(exits, [0]);
});

test("a bad state file is a one-line configuration error", () => {
  const configPath = join(dir, "c2.json");
  writeFileSync(
    configPath,
    JSON.stringify({ channels: [{ id: "log", type: "file", path: join(dir, "o.jsonl") }] }),
  );
  const state = join(dir, "bad-state.json");
  writeFileSync(state, "{nope");
  assert.throws(
    () =>
      main(
        { PULSE_NOTIFY_CONFIG: configPath, PULSE_NOTIFY_STATE: state },
        {
          createNotifier: (): Stoppable => ({ start() {}, async stop() {} }),
        },
      ),
    (err) => err instanceof ConfigError && !err.message.includes("\n"),
  );
});

test("a start on a v2 state file logs ledger migrated and keeps a backup", async () => {
  const configPath = join(dir, "c3.json");
  writeFileSync(
    configPath,
    JSON.stringify({ channels: [{ id: "log", type: "file", path: join(dir, "o.jsonl") }] }),
  );
  const state = join(dir, "v2-state.json");
  const v2 = JSON.stringify({
    version: 2,
    channels: {
      log: { "1:opened": { status: "delivered", at: 1 }, "2:opened": { status: "seeded", at: 2 } },
    },
  });
  writeFileSync(state, v2);
  const lines: string[] = [];
  const running = main(
    { PULSE_NOTIFY_CONFIG: configPath, PULSE_NOTIFY_STATE: state },
    {
      write: (line) => lines.push(line),
      createNotifier: (): Stoppable => ({ start() {}, async stop() {} }),
    },
  );
  await running.stop();
  const migrated = lines.map((l) => JSON.parse(l)).find((l) => l.msg === "ledger migrated");
  assert.equal(migrated?.from, 2);
  assert.equal(migrated?.entries, 2);
  assert.equal(migrated?.backup, `${state}.v2.bak`);
  assert.equal(readFileSync(`${state}.v2.bak`, "utf8"), v2);
  assert.equal(statSync(`${state}-wal`, { throwIfNoEntry: false })?.size ?? 0, 0);
});

test("a hostile SQLite state file stops startup and keeps its bytes", () => {
  const configPath = join(dir, "c4.json");
  writeFileSync(
    configPath,
    JSON.stringify({ channels: [{ id: "log", type: "file", path: join(dir, "o.jsonl") }] }),
  );
  const schema = `CREATE TABLE channels (id TEXT PRIMARY KEY, reminders_from INTEGER,
    manual_from INTEGER, check_routing TEXT, component_routing TEXT) STRICT;
    CREATE TABLE entries (channel_id TEXT NOT NULL, key TEXT NOT NULL, status TEXT NOT NULL,
    at INTEGER NOT NULL, payload TEXT, recipients TEXT, PRIMARY KEY (channel_id, key)) STRICT;
    PRAGMA user_version = 3; INSERT INTO channels (id) VALUES ('log');`;
  const row = (status: string, payload: string, recipients: string): string =>
    `${schema} INSERT INTO entries VALUES ('log', 'k', '${status}', 1, ${payload}, ${recipients});`;
  const cases = [
    `${schema} PRAGMA user_version = 4;`,
    "CREATE TABLE channels (id TEXT) STRICT; PRAGMA user_version = 3;",
    row("sent", "NULL", "NULL"),
    row("failed", "'[1]'", "NULL"),
    row("failed", "NULL", `'{"delivered":"x"}'`),
  ];
  cases.forEach((sql, i) => {
    const state = join(dir, `hostile-${i}.json`);
    const db = new Database(state, { create: true });
    db.run(sql);
    db.close();
    const bytes = readFileSync(state);
    assert.throws(
      () =>
        main(
          { PULSE_NOTIFY_CONFIG: configPath, PULSE_NOTIFY_STATE: state },
          { createNotifier: (): Stoppable => ({ start() {}, async stop() {} }) },
        ),
      (err) => err instanceof ConfigError && err.message.startsWith("cannot use state file"),
    );
    assert.deepEqual(readFileSync(state), bytes);
  });
});

test("health listener: ready after start, metrics without secrets, 503 while shutting down", async () => {
  const configPath = join(dir, "c3.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      channels: [{ id: "hook", type: "webhook", url: "https://user:s3cret@example.com/tok3n" }],
    }),
  );
  const gate = Promise.withResolvers<void>();
  const running = main(
    {
      PULSE_NOTIFY_CONFIG: configPath,
      PULSE_NOTIFY_STATE: join(dir, "state3.json"),
      PULSE_HEALTH_PORT: "0",
    },
    {
      write: () => {},
      createNotifier: (): Stoppable => ({ start() {}, stop: () => gate.promise }),
    },
  );
  const port = await running.listening;
  assert.ok(port);
  const base = `http://127.0.0.1:${port}`;
  for (const path of ["/healthz", "/readyz"]) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200, path);
    assert.equal(await res.text(), "ok\n", path);
  }
  assert.equal((await fetch(`${base}/readyz`, { method: "HEAD" })).status, 200);
  assert.equal((await fetch(`${base}/readyz`, { method: "POST" })).status, 405);
  const metrics = await (await fetch(`${base}/metrics`)).text();
  for (const series of [
    "pulse_up 1",
    'pulse_notify_polls_total{outcome="ok"} 0',
    'pulse_notify_deliveries_total{channel="hook",outcome="success"} 0',
    "pulse_notify_pending_deliveries 0",
  ]) {
    assert.ok(metrics.includes(series), series);
  }
  assert.doesNotMatch(metrics, /s3cret|tok3n|example\.com/);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  const stopped = running.stop();
  const after = await fetch(`${base}/readyz`).catch(() => undefined);
  if (after) assert.equal(after.status, 503);
  gate.resolve();
  await stopped;
});

test("a stuck stop logs a warn at the shutdown bound, then exits 1", async () => {
  const lines: string[] = [];
  const { handlers, exits, bound, fireBound } = await setup(() => new Promise(() => {}), {
    lines,
  });
  handlers.SIGTERM?.();
  await flush();
  assert.deepEqual(exits, []);
  assert.equal(bound()?.ms, 5000);
  fireBound();
  await flush();
  assert.deepEqual(exits, [1]);
  const warn = lines.map((l) => JSON.parse(l)).find((e) => e.level === "warn");
  assert.ok(warn);
});

test("an occupied health port rejects with one startup error and no started log or start", async () => {
  const blocker = createServer();
  await listen(blocker);
  const busy = (blocker.address() as AddressInfo).port;
  afterAll(() => close(blocker));
  const configPath = join(dir, "c5.json");
  writeFileSync(
    configPath,
    JSON.stringify({ channels: [{ id: "log", type: "file", path: join(dir, "o5.jsonl") }] }),
  );
  const lines: string[] = [];
  let starts = 0;
  const running = main(
    {
      PULSE_NOTIFY_CONFIG: configPath,
      PULSE_NOTIFY_STATE: join(dir, "state5.json"),
      PULSE_HEALTH_PORT: String(busy),
    },
    {
      write: (line) => lines.push(line),
      createNotifier: (): Stoppable => ({
        start() {
          starts += 1;
        },
        async stop() {},
      }),
    },
  );
  await assert.rejects(
    running.listening,
    (err) =>
      err instanceof StartupError &&
      /^cannot listen on 127\.0\.0\.1:\d+ \(PULSE_HEALTH_HOST\/PULSE_HEALTH_PORT\): .+$/.test(
        err.message,
      ),
  );
  assert.equal(starts, 0);
  assert.deepEqual(lines, []);
  // Stop it so its lock heartbeat does not outlive the test directory and exit the run.
  await running.stop();
});

test("entry point: occupied health port prints one line and exits 2", async () => {
  const blocker = createServer();
  await listen(blocker);
  afterAll(() => close(blocker));
  const busy = (blocker.address() as AddressInfo).port;
  const configPath = join(dir, "c6.json");
  writeFileSync(
    configPath,
    JSON.stringify({ channels: [{ id: "log", type: "file", path: join(dir, "o6.jsonl") }] }),
  );
  const child = spawn(process.execPath, [join(import.meta.dirname, "../src/index.ts")], {
    env: {
      ...process.env,
      PULSE_NOTIFY_CONFIG: configPath,
      PULSE_NOTIFY_STATE: join(dir, "state6.json"),
      PULSE_HEALTH_PORT: String(busy),
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    stdout += d;
  });
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  const code = await new Promise((resolve) => child.once("close", resolve));
  assert.equal(code, 2);
  assert.equal(stdout, "");
  assert.match(
    stderr,
    /^pulse-notify: cannot listen on 127\.0\.0\.1:\d+ \(PULSE_HEALTH_HOST\/PULSE_HEALTH_PORT\): [^\n]+\n$/,
  );
});

test("a failing notifier constructor closes the ledger and frees the lock", async () => {
  const configPath = join(dir, "c-ctor.json");
  writeFileSync(
    configPath,
    JSON.stringify({ channels: [{ id: "log", type: "file", path: join(dir, "o.jsonl") }] }),
  );
  const env = { PULSE_NOTIFY_CONFIG: configPath, PULSE_NOTIFY_STATE: join(dir, "ctor.db") };
  const boom = new Error(
    "cannot drop pending incident notifications of channels with sendIncidents false",
  );
  assert.throws(
    () =>
      main(env, {
        createNotifier: (): Stoppable => {
          throw boom;
        },
      }),
    (err) => err === boom,
  );
  const running = main(env, { createNotifier: (): Stoppable => ({ start() {}, async stop() {} }) });
  await running.stop();
});

test("PULSE_NOTIFY_BUDGET_THRESHOLD outside 0..100 stops startup", () => {
  const configPath = join(dir, "c-threshold.json");
  writeFileSync(
    configPath,
    JSON.stringify({ channels: [{ id: "log", type: "file", path: join(dir, "o.jsonl") }] }),
  );
  for (const value of ["101", "-1", "25.5", "abc", "25abc"]) {
    assert.throws(
      () =>
        main(
          {
            PULSE_NOTIFY_CONFIG: configPath,
            PULSE_NOTIFY_STATE: join(dir, "threshold.db"),
            PULSE_NOTIFY_BUDGET_THRESHOLD: value,
          },
          { createNotifier: (): Stoppable => ({ start() {}, async stop() {} }) },
        ),
      (err) =>
        err instanceof StartupError &&
        err.message === "PULSE_NOTIFY_BUDGET_THRESHOLD: must be an integer from 0 to 100" &&
        !err.message.includes(value),
    );
  }
});

const TOKEN = "sentinel-notify-token-0123456789";
const fakeNotifier = { createNotifier: (): Stoppable => ({ start() {}, async stop() {} }) };

test("token mode starts without a config file; without a token the file stays required", async () => {
  const state = join(dir, "token-mode.db");
  const running = main({ PULSE_NOTIFY_API_TOKEN: TOKEN, PULSE_NOTIFY_STATE: state }, fakeNotifier);
  await running.stop();
  const empty = join(dir, "c-empty.json");
  writeFileSync(empty, JSON.stringify({ channels: [] }));
  const withEmpty = main(
    { PULSE_NOTIFY_API_TOKEN: TOKEN, PULSE_NOTIFY_CONFIG: empty, PULSE_NOTIFY_STATE: state },
    fakeNotifier,
  );
  await withEmpty.stop();
  assert.throws(
    () => main({ PULSE_NOTIFY_STATE: state }, fakeNotifier),
    /PULSE_NOTIFY_CONFIG is required/,
  );
  assert.throws(
    () => main({ PULSE_NOTIFY_CONFIG: empty, PULSE_NOTIFY_STATE: state }, fakeNotifier),
    (err) => err instanceof ConfigError && /non-empty array/.test(err.message),
  );
});

test("bad token settings stop startup without the token in the message", () => {
  const tokenFile = join(dir, "token");
  writeFileSync(tokenFile, `${TOKEN}\n`);
  const emptyFile = join(dir, "token-empty");
  writeFileSync(emptyFile, "  \n");
  const state = join(dir, "token-bad.db");
  const cases: [string, Record<string, string>, RegExp][] = [
    [
      "both sources",
      { PULSE_NOTIFY_API_TOKEN: TOKEN, PULSE_NOTIFY_API_TOKEN_FILE: tokenFile },
      /set only one of PULSE_NOTIFY_API_TOKEN and PULSE_NOTIFY_API_TOKEN_FILE/,
    ],
    ["empty file", { PULSE_NOTIFY_API_TOKEN_FILE: emptyFile }, /file is empty/],
    ["missing file", { PULSE_NOTIFY_API_TOKEN_FILE: join(dir, "nope") }, /cannot read \(ENOENT\)/],
  ];
  for (const [name, env, message] of cases) {
    assert.throws(
      () => main({ ...env, PULSE_NOTIFY_STATE: state }, fakeNotifier),
      (err) =>
        err instanceof StartupError && message.test(err.message) && !err.message.includes(TOKEN),
      name,
    );
  }
});

test("entry point: two token sources exit 2 with one line that holds no token", async () => {
  const tokenFile = join(dir, "token-entry");
  writeFileSync(tokenFile, TOKEN);
  const child = spawn(process.execPath, [join(import.meta.dirname, "../src/index.ts")], {
    env: {
      ...process.env,
      PULSE_NOTIFY_API_TOKEN: TOKEN,
      PULSE_NOTIFY_API_TOKEN_FILE: tokenFile,
      PULSE_NOTIFY_STATE: join(dir, "state-entry.db"),
    },
  });
  let output = "";
  child.stdout.on("data", (d) => {
    output += d;
  });
  child.stderr.on("data", (d) => {
    output += d;
  });
  const code = await new Promise((resolve) => child.once("close", resolve));
  assert.equal(code, 2);
  assert.match(output, /set only one of PULSE_NOTIFY_API_TOKEN and PULSE_NOTIFY_API_TOKEN_FILE/);
  assert.equal(output.includes(TOKEN), false);
});

/** A fake timer list: each entry runs only when the test fires it. */
function fakeTimers() {
  const timers: { fn: () => void; ms: number; isCancelled: boolean }[] = [];
  const schedule: Schedule = (fn, ms) => {
    const timer = { fn, ms, isCancelled: false };
    timers.push(timer);
    return () => {
      timer.isCancelled = true;
    };
  };
  const fire = (ms: number): boolean => {
    const timer = timers.find((t) => t.ms === ms && !t.isCancelled);
    if (timer === undefined) return false;
    timer.isCancelled = true;
    timer.fn();
    return true;
  };
  return { timers, schedule, fire };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !check(); i++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(check(), "condition not reached");
}

const REVISION = `sha256-${"7".repeat(64)}`;
const HOOK_SECRET = "sentinel-hook-path-0123456789";

test("token mode: a database channel installs after one poll, reports follow every poll and the 60000 ms heartbeat, shutdown stops all", async () => {
  const api = await startFakeApi();
  const receiver = await startReceiver();
  const hook = `${receiver.url}/${HOOK_SECRET}`;
  api.incidents = [];
  api.notifyChannels = {
    etag: '"r1"',
    body: {
      revision: REVISION,
      channels: [
        {
          id: "db",
          type: "webhook",
          urlEnv: "PULSE_NOTIFY_SECRET_HOOK",
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    },
  };
  const state = join(dir, "token-loop.db");
  const lines: string[] = [];
  const timers = fakeTimers();
  try {
    const running = main(
      {
        PULSE_NOTIFY_API_TOKEN: TOKEN,
        PULSE_NOTIFY_STATE: state,
        PULSE_API_URL: api.url,
        PULSE_NOTIFY_SECRET_HOOK: hook,
      },
      { write: (line) => lines.push(line), channelSchedule: timers.schedule, now: () => 1_000 },
    );
    await running.listening;
    assert.equal(timers.fire(0), true);
    await until(() => api.reports.length === 1);
    const report = api.reports[0] as Record<string, unknown>;
    assert.equal(validateNotifyServiceReport(report).ok, true);
    assert.equal(report.appliedRevision, REVISION);
    assert.deepEqual(report.rejected, []);
    assert.deepEqual(report.shadowedIds, []);
    assert.equal(report.startedAt, 1_000);
    // The next poll uses the ETag and gets a 304; a report still follows the attempt.
    await until(() => timers.timers.some((t) => t.ms === 15_000));
    assert.equal(timers.fire(15_000), true);
    await until(() => api.reports.length === 2);
    assert.equal(timers.fire(60_000), true);
    await until(() => api.reports.length === 3);
    await running.stop();
    const after = api.requested.length;
    assert.equal(timers.fire(15_000), false);
    assert.equal(timers.fire(60_000), false);
    assert.equal(api.requested.length, after);
    assert.equal(api.requested.filter((p) => p === "/service/notify/channels").length, 2);
    const seen = JSON.stringify(api.reports) + lines.join("\n");
    assert.equal(seen.includes(TOKEN), false);
    assert.equal(seen.includes(HOOK_SECRET), false);
    const ledger = new Ledger(state);
    try {
      assert.deepEqual(
        ledger.remoteChannels().map((r) => [r.id, r.revision]),
        [["db", REVISION]],
      );
    } finally {
      ledger.close();
    }
  } finally {
    await api.close();
    await receiver.close();
  }
});

test("tokenless mode re-reads the file and makes 0 service calls and 0 reports", async () => {
  const api = await startFakeApi();
  const configPath = join(dir, "tokenless.json");
  writeFileSync(
    configPath,
    JSON.stringify({ channels: [{ id: "log", type: "file", path: join(dir, "t.jsonl") }] }),
  );
  const timers = fakeTimers();
  try {
    const running = main(
      {
        PULSE_NOTIFY_CONFIG: configPath,
        PULSE_NOTIFY_STATE: join(dir, "tokenless.db"),
        PULSE_API_URL: api.url,
      },
      { write: () => {}, channelSchedule: timers.schedule },
    );
    await running.listening;
    assert.equal(timers.fire(0), true);
    assert.equal(
      timers.timers.some((t) => t.ms === 60_000),
      false,
    );
    await until(() => timers.timers.some((t) => t.ms === 15_000));
    await running.stop();
    assert.equal(api.requested.filter((p) => p.startsWith("/service/")).length, 0);
    assert.equal(api.reports.length, 0);
  } finally {
    await api.close();
  }
});

test("an old api that answers 404 on the channels gives file channels only, logged once", async () => {
  const api = await startFakeApi();
  const lines: string[] = [];
  const timers = fakeTimers();
  try {
    const running = main(
      {
        PULSE_NOTIFY_API_TOKEN: TOKEN,
        PULSE_NOTIFY_STATE: join(dir, "old-api.db"),
        PULSE_API_URL: api.url,
      },
      { write: (line) => lines.push(line), channelSchedule: timers.schedule },
    );
    await running.listening;
    timers.fire(0);
    await until(() => timers.timers.some((t) => t.ms === 15_000));
    timers.fire(15_000);
    await until(() => timers.timers.filter((t) => t.ms === 15_000).length === 2);
    await running.stop();
    assert.equal(lines.filter((l) => l.includes("the api has no database channels")).length, 1);
  } finally {
    await api.close();
  }
});
