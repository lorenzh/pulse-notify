import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
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
        once: (signal, handler) => {
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
