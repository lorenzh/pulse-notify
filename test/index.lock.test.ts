import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ConfigError } from "../src/config.ts";
import { type MainDeps, main, type Stoppable } from "../src/index.ts";
import type { Schedule } from "../src/types.ts";

const dir = mkdtempSync(join(tmpdir(), "notify-main-lock-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
const configPath = join(dir, "config.json");
writeFileSync(
  configPath,
  JSON.stringify({ channels: [{ id: "log", type: "file", path: join(dir, "o.jsonl") }] }),
);

function setup(over: { env?: Record<string, string>; deps?: MainDeps } = {}) {
  const state = join(dir, `state-${counter++}.json`);
  const exits: number[] = [];
  const lines: string[] = [];
  const beats: (() => void)[] = [];
  const heartbeatSchedule: Schedule = (fn) => {
    beats.push(fn);
    return () => {};
  };
  let clock = 1_000_000;
  const stops: number[] = [];
  const running = main(
    { PULSE_NOTIFY_CONFIG: configPath, PULSE_NOTIFY_STATE: state, ...over.env },
    {
      process: { on() {} },
      exit: (code) => exits.push(code),
      write: (l) => lines.push(l),
      heartbeatSchedule,
      lock: { now: () => clock, hostname: () => "host-a", pid: 111, token: () => "tok-1" },
      createNotifier: (): Stoppable => ({
        start() {},
        async stop() {
          stops.push(1);
        },
      }),
      ...over.deps,
    },
  );
  return {
    state,
    running,
    exits,
    lines,
    beats,
    stops,
    setClock: (ms: number) => {
      clock = ms;
    },
  };
}

const readLock = (state: string): { token: string; heartbeat: number } =>
  JSON.parse(readFileSync(`${state}.lock`, "utf8"));

test("the lock exists while running and is removed on stop", async () => {
  const s = setup();
  assert.equal(readLock(s.state).token, "tok-1");
  await s.running.stop();
  assert.equal(existsSync(`${s.state}.lock`), false);
});

test("a second process on the same state file is a configuration error", async () => {
  const s = setup();
  assert.throws(
    () =>
      main(
        { PULSE_NOTIFY_CONFIG: configPath, PULSE_NOTIFY_STATE: s.state },
        {
          process: { on() {} },
          lock: { hostname: () => "host-a", pid: 222, isPidAlive: () => true },
          createNotifier: (): Stoppable => ({ start() {}, async stop() {} }),
        },
      ),
    (err) => err instanceof ConfigError && /in use by host-a pid 111/.test(err.message),
  );
  assert.equal(readLock(s.state).token, "tok-1", "the first holder keeps the lock");
  await s.running.stop();
});

test("a bad state file frees the lock again", () => {
  const state = join(dir, "bad.json");
  writeFileSync(state, "{nope");
  assert.throws(
    () =>
      main(
        { PULSE_NOTIFY_CONFIG: configPath, PULSE_NOTIFY_STATE: state },
        {
          process: { on() {} },
          createNotifier: (): Stoppable => ({ start() {}, async stop() {} }),
        },
      ),
    ConfigError,
  );
  assert.equal(existsSync(`${state}.lock`), false);
});

const beatsRef: (() => void)[] = [];

test("the heartbeat refreshes the lock file on its timer, every lease/6", async () => {
  const delays: number[] = [];
  const s = setup({
    env: { PULSE_NOTIFY_LOCK_LEASE_SECONDS: "60" },
    deps: {
      heartbeatSchedule: (fn, ms) => {
        delays.push(ms);
        beatsRef.push(fn);
        return () => {};
      },
    },
  });
  assert.deepEqual(delays, [10_000]);
  s.setClock(1_010_000);
  beatsRef.pop()?.();
  assert.equal(readLock(s.state).heartbeat, 1_010_000);
  assert.deepEqual(delays, [10_000, 10_000], "the next beat is scheduled");
  await s.running.stop();
});

test("a lock taken over by another process stops the service without writing", async () => {
  const s = setup();
  writeFileSync(
    `${s.state}.lock`,
    JSON.stringify({ pid: 9, hostname: "host-b", token: "foreign", heartbeat: 1_000_000 }),
  );
  s.beats.pop()?.();
  assert.deepEqual(s.exits, [2]);
  assert.equal(s.stops.length, 1);
  assert.ok(s.lines.some((l) => l.includes("state lock lost")));
  assert.equal(readLock(s.state).token, "foreign", "the foreign lock is left alone");
});

test("batched ledger changes are flushed on stop, before the lock is freed", async () => {
  const state = join(dir, "flush.json");
  const running = main(
    { PULSE_NOTIFY_CONFIG: configPath, PULSE_NOTIFY_STATE: state },
    {
      process: { on() {} },
      write: () => {},
      heartbeatSchedule: () => () => {},
      createNotifier: (opts): Stoppable => ({
        start() {},
        async stop() {
          opts.ledger.claim("log", "1:opened", {
            key: "1:opened",
            event: "opened",
            incidentId: 1,
            checkId: "c",
            checkName: "C",
            reason: null,
            time: "2026-01-01T00:00:00.000Z",
            timeMs: 0,
            openedMs: 0,
          });
          opts.ledger.settle("log", "1:opened", "delivered");
        },
      }),
    },
  );
  await running.stop();
  assert.equal(
    JSON.parse(readFileSync(state, "utf8")).channels.log["1:opened"].status,
    "delivered",
  );
  assert.equal(existsSync(`${state}.lock`), false);
});

test("the startup log shows the API url without user info, query or fragment", async () => {
  const s = setup({
    env: { PULSE_API_URL: "https://user:pw@api.example.com/base?token=abc#frag" },
  });
  const started = s.lines.map((l) => JSON.parse(l)).find((e) => e.msg === "pulse-notify started");
  assert.equal(started.apiUrl, "https://api.example.com/base");
  const all = s.lines.join("");
  for (const secret of ["user", "pw", "token", "abc", "frag"]) {
    assert.equal(all.includes(`${secret}:`) || all.includes("abc"), false, secret);
  }
  await s.running.stop();
});

test("start creates a missing state directory and the lock", async () => {
  const nested = join(dir, "missing", "deep", "state.json");
  const t = setup({ env: { PULSE_NOTIFY_STATE: nested } });
  await t.running.listening;
  assert.equal(existsSync(`${nested}.lock`), true);
  assert.deepEqual(t.exits, []);
  await t.running.stop();
});

test("a state parent that is a file throws ConfigError", () => {
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "x");
  assert.throws(
    () => setup({ env: { PULSE_NOTIFY_STATE: join(blocker, "state.json") } }),
    (err: unknown) => err instanceof ConfigError && /^cannot use state file /.test(err.message),
  );
});
