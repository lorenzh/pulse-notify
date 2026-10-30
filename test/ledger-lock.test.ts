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

test("two contenders on one stale lock: exactly one wins, the winner's lock stays", () => {
  const state = statePath();
  writeLock(state, { pid: 55, hostname: "host-a", token: "old", heartbeat: 1 });
  const isAlive = (pid: number): boolean => pid !== 55;
  let loser: unknown;
  let inner: ReturnType<typeof acquireLock> | undefined;
  const outerDeps = deps({
    isPidAlive: isAlive,
    token: () => "token-a",
    afterHolderRead: () => {
      // B runs completely inside A's window and wins.
      inner = acquireLock(state, deps({ isPidAlive: isAlive, token: () => "token-b", pid: 200 }));
    },
  });
  try {
    acquireLock(state, outerDeps);
  } catch (err) {
    loser = err;
  }
  assert.ok(inner);
  assert.ok(loser instanceof ConfigError);
  assert.equal(read(state).token, "token-b");
  assert.equal(existsSync(`${state}.lock.takeover`), false);
});

test("a contender that meets a live marker loses and leaves the marker", () => {
  const state = statePath();
  writeLock(state, { pid: 55, hostname: "host-a", token: "old", heartbeat: 1 });
  writeFileSync(
    `${state}.lock.takeover`,
    JSON.stringify({ pid: 300, hostname: "host-a", token: "m", at: 999_999 }),
  );
  assert.throws(
    () => acquireLock(state, deps({ isPidAlive: (pid) => pid !== 55 })),
    (err: unknown) => err instanceof ConfigError && /\.lock\.takeover/.test(err.message),
  );
  assert.equal(read(state).token, "old");
  assert.equal(existsSync(`${state}.lock.takeover`), true);
});

test("a stale marker (old time, or dead pid) is cleared and the takeover succeeds", () => {
  for (const marker of [
    { pid: 300, hostname: "host-a", token: "m", at: 1 },
    { pid: 301, hostname: "host-a", token: "m", at: 999_999 },
  ]) {
    const state = statePath();
    writeLock(state, { pid: 55, hostname: "host-a", token: "old", heartbeat: 1 });
    writeFileSync(`${state}.lock.takeover`, JSON.stringify(marker));
    const lock = acquireLock(state, deps({ isPidAlive: (pid) => pid === 300 }));
    assert.ok(lock);
    assert.equal(read(state).token, "token-own");
    assert.equal(existsSync(`${state}.lock.takeover`), false);
  }
});

test("a corrupt marker fails closed with the marker path", () => {
  const state = statePath();
  writeLock(state, { pid: 55, hostname: "host-a", token: "old", heartbeat: 1 });
  writeFileSync(`${state}.lock.takeover`, "{nope");
  assert.throws(
    () => acquireLock(state, deps({ isPidAlive: () => false })),
    (err: unknown) => err instanceof ConfigError && err.message.includes(`${state}.lock.takeover`),
  );
  assert.equal(existsSync(`${state}.lock.takeover`), true);
});

test("the marker is removed when the takeover fails", () => {
  const state = statePath();
  writeLock(state, { pid: 55, hostname: "host-a", token: "old", heartbeat: 1 });
  let alive = false;
  assert.throws(
    () =>
      acquireLock(
        state,
        deps({
          isPidAlive: () => alive,
          afterHolderRead: () => {
            alive = true; // the holder revives between the read and the re-check
          },
        }),
      ),
    ConfigError,
  );
  assert.equal(existsSync(`${state}.lock.takeover`), false);
  assert.equal(read(state).token, "old");
});

test("the marker is taken during a successful takeover and removed after acquisition", () => {
  const state = statePath();
  writeLock(state, { pid: 55, hostname: "host-a", token: "old", heartbeat: 1 });
  let isMarkerSeen = false;
  const lock = acquireLock(
    state,
    deps({
      isPidAlive: () => false,
      afterMarker: () => {
        isMarkerSeen = existsSync(`${state}.lock.takeover`);
      },
    }),
  );
  assert.equal(isMarkerSeen, true);
  assert.equal(read(state).token, "token-own");
  assert.equal(existsSync(`${state}.lock.takeover`), false);
  lock.release();
});

test("the parent directory is created before the lock", () => {
  const state = join(dir, "a", "b", "state.json");
  const lock = acquireLock(state, deps());
  assert.equal(existsSync(`${state}.lock`), true);
  lock.release();
});

test("a parent that is a file gives one ConfigError line", () => {
  const file = statePath();
  writeFileSync(file, "x");
  assert.throws(
    () => acquireLock(join(file, "state.json"), deps()),
    (err: unknown) =>
      err instanceof ConfigError &&
      err.message.startsWith("cannot use state file ") &&
      !err.message.includes("\n"),
  );
});
