import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ConfigError } from "../src/config.ts";
import { main, type Stoppable } from "../src/index.ts";

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
