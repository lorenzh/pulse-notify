import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LockDeps } from "../src/ledger-lock.ts";

/** A fresh `mkdtemp` directory and its cleanup. */
export function tempDir(prefix: string): { dir: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A manual clock: tests move `t` by hand. */
export interface ManualClock {
  t: number;
  now: () => number;
}

export function manualClock(start = 0): ManualClock {
  const clock: ManualClock = { t: start, now: () => clock.t };
  return clock;
}

/** A fake scheduler: timers run only when the test calls `advanceTo`. */
export interface FakeScheduler {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  /** Moves the clock to `t`, running each due timer at its own time, in order. */
  advanceTo: (t: number) => void;
  pending: () => number;
}

export function fakeScheduler(clock: ManualClock): FakeScheduler {
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout: (fn, ms) => {
      seq += 1;
      timers.set(seq, { at: clock.t + ms, fn });
      return seq;
    },
    clearTimeout: (handle) => {
      if (typeof handle === "number") timers.delete(handle);
    },
    advanceTo: (t) => {
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | undefined;
        for (const entry of timers) {
          if (entry[1].at <= t && (next === undefined || entry[1].at < next[1].at)) next = entry;
        }
        if (next === undefined) break;
        timers.delete(next[0]);
        clock.t = next[1].at;
        next[1].fn();
      }
      clock.t = t;
    },
    pending: () => timers.size,
  };
}

/** Lock dependencies of a lone test process. */
export function testLockDeps(now: () => number = Date.now): LockDeps {
  let n = 0;
  return {
    now,
    hostname: () => "test-host",
    pid: process.pid,
    isPidAlive: () => true,
    leaseSeconds: 60,
    token: () => `token-${++n}`,
  };
}

/** A second connection to the store file, as another process would see it. */
export function readStore<T>(path: string, read: (db: Database) => T): T {
  const db = new Database(path, { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

export function countRows(path: string, sql: string, ...params: string[]): number {
  return readStore(path, (db) => {
    const row = db.query<{ n: number }, string[]>(sql).get(...params);
    return row?.n ?? -1;
  });
}
