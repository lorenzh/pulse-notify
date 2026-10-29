import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ConfigError } from "../src/config.ts";
import { main, type Stoppable } from "../src/index.ts";
import { close, listen } from "./support.ts";

const dir = mkdtempSync(join(tmpdir(), "notify-main-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function setup(stop: () => Promise<void>) {
  const configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ channels: [{ id: "log", type: "file", path: join(dir, "o.jsonl") }] }),
  );
  const handlers: Record<string, () => void> = {};
  const exits: number[] = [];
  let boundTimer: (() => void) | undefined;
  main(
    { PULSE_NOTIFY_CONFIG: configPath, PULSE_NOTIFY_STATE: join(dir, "state.json") },
    {
      process: {
        on: (signal, handler) => {
          handlers[signal] = handler;
        },
      },
      exit: (code) => exits.push(code),
      schedule: (fn) => {
        boundTimer = fn;
        return () => {};
      },
      createNotifier: (): Stoppable => ({ start() {}, stop }),
    },
  );
  return { handlers, exits, fireBound: () => boundTimer?.() };
}

const flush = () => new Promise((r) => setImmediate(r));

test("SIGTERM exits with 0 only after stop resolved", async () => {
  const gate = Promise.withResolvers<void>();
  const { handlers, exits } = setup(() => gate.promise);
  handlers.SIGTERM?.();
  await flush();
  assert.deepEqual(exits, []);
  gate.resolve();
  await flush();
  assert.deepEqual(exits, [0]);
});

test("a slow stop does not hang: the bound forces the exit", async () => {
  const { handlers, exits, fireBound } = setup(() => new Promise(() => {}));
  handlers.SIGINT?.();
  await flush();
  assert.deepEqual(exits, []);
  fireBound();
  await flush();
  assert.deepEqual(exits, [0]);
});

test("signal handlers are registered before settings, config and ledger are read", () => {
  const order: string[] = [];
  assert.throws(
    () =>
      main(
        {},
        {
          process: {
            on: (signal) => {
              order.push(signal);
            },
          },
        },
      ),
    /PULSE_NOTIFY_CONFIG is required/,
  );
  assert.deepEqual(order, ["SIGINT", "SIGTERM"]);
});

test("a second signal does nothing more", async () => {
  let stops = 0;
  const { handlers, exits } = setup(async () => {
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
          process: { on() {} },
          createNotifier: (): Stoppable => ({ start() {}, async stop() {} }),
        },
      ),
    (err) => err instanceof ConfigError && !err.message.includes("\n"),
  );
});

test("health listener: ready after start, metrics without secrets, 503 while shutting down", async () => {
  const configPath = join(dir, "c3.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      channels: [{ id: "hook", type: "webhook", url: "https://user:s3cret@example.com/tok3n" }],
    }),
  );
  const handlers: Record<string, () => void> = {};
  const exits: number[] = [];
  const gate = Promise.withResolvers<void>();
  const running = main(
    {
      PULSE_NOTIFY_CONFIG: configPath,
      PULSE_NOTIFY_STATE: join(dir, "state3.json"),
      PULSE_HEALTH_PORT: "0",
    },
    {
      process: {
        on: (signal, handler) => {
          handlers[signal] = handler;
        },
      },
      exit: (code) => exits.push(code),
      write: () => {},
      createNotifier: (): Stoppable => ({ start() {}, stop: () => gate.promise }),
    },
  );
  const port = await running.listening;
  assert.ok(port);
  const base = `http://127.0.0.1:${port}`;
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), "ok\n");
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
  handlers.SIGTERM?.();
  const after = await fetch(`${base}/healthz`).catch(() => undefined);
  if (after) assert.equal(after.status, 503);
  gate.resolve();
  await flush();
});

test("a stuck stop logs a warn at the shutdown bound, then exits 0", async () => {
  const configPath = join(dir, "c4.json");
  writeFileSync(
    configPath,
    JSON.stringify({ channels: [{ id: "log", type: "file", path: join(dir, "o4.jsonl") }] }),
  );
  const handlers: Record<string, () => void> = {};
  const exits: number[] = [];
  const lines: string[] = [];
  let bound: { fn: () => void; ms: number } | undefined;
  main(
    { PULSE_NOTIFY_CONFIG: configPath, PULSE_NOTIFY_STATE: join(dir, "state4.json") },
    {
      process: {
        on: (signal, handler) => {
          handlers[signal] = handler;
        },
      },
      exit: (code) => exits.push(code),
      write: (line) => lines.push(line),
      shutdownTimeoutMs: 50,
      schedule: (fn, ms) => {
        bound = { fn, ms };
        return () => {};
      },
      createNotifier: (): Stoppable => ({ start() {}, stop: () => new Promise(() => {}) }),
    },
  );
  handlers.SIGTERM?.();
  await flush();
  assert.deepEqual(exits, []);
  assert.equal(bound?.ms, 50);
  bound?.fn();
  await flush();
  assert.deepEqual(exits, [0]);
  const warn = lines.map((l) => JSON.parse(l)).find((e) => e.level === "warn");
  assert.ok(warn);
});

test("an occupied health port exits 2 with one plain line and no started log or start", async () => {
  const blocker = createServer();
  await listen(blocker);
  const busy = (blocker.address() as AddressInfo).port;
  after(() => close(blocker));
  const configPath = join(dir, "c5.json");
  writeFileSync(
    configPath,
    JSON.stringify({ channels: [{ id: "log", type: "file", path: join(dir, "o5.jsonl") }] }),
  );
  const exits: number[] = [];
  const errors: string[] = [];
  const lines: string[] = [];
  let starts = 0;
  const running = main(
    {
      PULSE_NOTIFY_CONFIG: configPath,
      PULSE_NOTIFY_STATE: join(dir, "state5.json"),
      PULSE_HEALTH_PORT: String(busy),
    },
    {
      process: { on() {} },
      exit: (code) => exits.push(code),
      write: (line) => lines.push(line),
      writeError: (line) => errors.push(line),
      createNotifier: (): Stoppable => ({
        start() {
          starts += 1;
        },
        async stop() {},
      }),
    },
  );
  assert.equal(await running.listening, undefined);
  assert.deepEqual(exits, [2]);
  assert.equal(errors.length, 1);
  assert.match(
    errors[0] ?? "",
    /^pulse-notify: cannot listen on 127\.0\.0\.1:\d+ \(PULSE_HEALTH_HOST\/PULSE_HEALTH_PORT\): .+\n$/,
  );
  assert.equal(starts, 0);
  assert.deepEqual(lines, []);
});

test("entry point: occupied health port prints one line and exits 2", async () => {
  const blocker = createServer();
  await listen(blocker);
  after(() => close(blocker));
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
