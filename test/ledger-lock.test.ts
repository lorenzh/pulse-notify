import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ConfigError } from "../src/config.ts";
import {
  acquireLock,
  heartbeatIntervalSeconds,
  type LockDeps,
  LockLostError,
} from "../src/ledger-lock.ts";
import { type SpyLogger, spyLogger } from "./support.ts";

const dir = mkdtempSync(join(tmpdir(), "notify-lock-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;
const statePath = (): string => join(dir, `state-${counter++}.json`);

function deps(over: Partial<LockDeps> & { logger?: SpyLogger } = {}): LockDeps {
  return {
    now: () => 1_000_000,
    hostname: () => "host-a",
    pid: 100,
    isPidAlive: () => true,
    leaseSeconds: 60,
    token: () => "token-own",
    ...over,
  };
}

function writeLock(
  state: string,
  holder: { pid: number; hostname: string; token: string; heartbeat: number },
): void {
  writeFileSync(`${state}.lock`, JSON.stringify(holder));
}

const read = (state: string): { token: string; heartbeat: number; pid: number } =>
  JSON.parse(readFileSync(`${state}.lock`, "utf8"));

test("the first process takes the lock and release removes it", () => {
  const state = statePath();
  const lock = acquireLock(state, deps());
  assert.equal(read(state).token, "token-own");
  lock.release();
  assert.equal(existsSync(`${state}.lock`), false);
});

test("a live holder on this host (another live pid) gives exit 2 with the holder", () => {
  const state = statePath();
  writeLock(state, { pid: 55, hostname: "host-a", token: "t", heartbeat: 990_000 });
  assert.throws(
    () => acquireLock(state, deps({ isPidAlive: (pid) => pid === 55 })),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /in use by host-a pid 55 \(heartbeat 10s ago; remove .*\.lock if/);
      return true;
    },
  );
  assert.equal(read(state).token, "t");
});

test("same host, dead pid: stale, taken over with a warning", () => {
  const state = statePath();
  const logger = spyLogger();
  writeLock(state, { pid: 55, hostname: "host-a", token: "old", heartbeat: 999_999 });
  const lock = acquireLock(state, deps({ isPidAlive: () => false, logger }));
  assert.equal(read(state).token, "token-own");
  assert.ok(logger.entries.some((e) => e.level === "warn" && /stale/.test(e.msg)));
  lock.release();
});

test("same host, same pid as ours: stale (a restarted container)", () => {
  const state = statePath();
  writeLock(state, { pid: 100, hostname: "host-a", token: "old", heartbeat: 999_999 });
  acquireLock(state, deps({ isPidAlive: () => true }));
  assert.equal(read(state).token, "token-own");
});

test("another host with a fresh heartbeat is live, whatever the pid says", () => {
  for (const holderPid of [55, 100]) {
    for (const isAlive of [true, false]) {
      const state = statePath();
      writeLock(state, { pid: holderPid, hostname: "host-b", token: "t", heartbeat: 970_000 });
      assert.throws(
        () => acquireLock(state, deps({ isPidAlive: () => isAlive })),
        ConfigError,
        `pid ${holderPid} alive ${isAlive}`,
      );
      assert.equal(read(state).token, "t");
    }
  }
});

test("another host with a heartbeat older than the lease is stale", () => {
  const state = statePath();
  const logger = spyLogger();
  writeLock(state, { pid: 55, hostname: "host-b", token: "old", heartbeat: 939_000 });
  acquireLock(state, deps({ logger }));
  assert.equal(read(state).token, "token-own");
  assert.equal(logger.entries.filter((e) => e.level === "warn").length, 1);
});

test("a corrupt or unreadable lock is live: exit 2, never taken over", () => {
  for (const content of ["{nope", "[]", JSON.stringify({ pid: 1 }), ""]) {
    const state = statePath();
    writeFileSync(`${state}.lock`, content);
    assert.throws(
      () => acquireLock(state, deps({ isPidAlive: () => false })),
      /cannot be read/,
      content,
    );
    assert.equal(readFileSync(`${state}.lock`, "utf8"), content);
  }
});

test("two racing takeovers: the one whose token is not in the file loses", () => {
  const state = statePath();
  writeLock(state, { pid: 55, hostname: "host-a", token: "old", heartbeat: 1 });
  // After the winner took over, the loser's pid check passes once more and its create fails.
  const winner = acquireLock(state, deps({ isPidAlive: () => false, token: () => "winner" }));
  assert.throws(
    () =>
      acquireLock(
        state,
        deps({
          hostname: () => "host-c",
          pid: 7,
          token: () => {
            return "loser";
          },
        }),
      ),
    ConfigError,
  );
  assert.equal(read(state).token, "winner");
  winner.release();
});

test("the heartbeat rewrites the file; a foreign token stops it", () => {
  const state = statePath();
  let clock = 1_000_000;
  const lock = acquireLock(state, deps({ now: () => clock }));
  clock = 1_010_000;
  lock.heartbeat();
  assert.equal(read(state).heartbeat, 1_010_000);
  assert.equal(read(state).token, "token-own");
  writeLock(state, { pid: 9, hostname: "host-b", token: "other", heartbeat: clock });
  assert.throws(() => lock.heartbeat(), LockLostError);
  // A lock that is not ours is not removed.
  lock.release();
  assert.equal(read(state).token, "other");
  rmSync(`${state}.lock`);
  assert.throws(() => lock.heartbeat(), LockLostError);
});

test("the heartbeat interval is a sixth of the lease", () => {
  assert.equal(heartbeatIntervalSeconds(60), 10);
  assert.equal(heartbeatIntervalSeconds(30), 5);
});
