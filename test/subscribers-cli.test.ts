import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { acquireLock } from "../src/ledger-lock.ts";
import { SubscriberStore } from "../src/subscriber-store.ts";
import { runSubscribers } from "../src/subscribers-cli.ts";
import { countRows, tempDir, testLockDeps } from "./subscriptions-support.ts";

const USAGE = "usage: pulse-notify subscribers delete <address>";
let dir: string;
let remove: () => void;
let path: string;

beforeEach(() => {
  ({ dir, remove } = tempDir("notify-subs-cli-"));
  path = join(dir, "subs.db");
});
afterEach(() => remove());

const run = (...args: string[]): { lines: string[]; code: number } =>
  runSubscribers(args, { storePath: path, lock: testLockDeps() });

/** A store with a confirmed `sub-a`, a pending `sub-b` and a delivery row of each. */
function seed(): void {
  const s = SubscriberStore.open(path);
  s.insertPending({ id: "A", email: "sub-a@example.com", now: 1, digest: "dA", expiresAt: 9e9 });
  s.confirm("A", 1);
  s.insertPending({ id: "B", email: "sub-b@example.com", now: 1, digest: "dB", expiresAt: 9e9 });
  s.addPendingEvents([{ key: "E1", manualId: 1, payload: "{}" }], 5);
  s.completeDelivery({ eventKey: "E1", subscriptionId: "A", status: "sent", attempts: 1, at: 6 });
  s.completeDelivery({ eventKey: "E1", subscriptionId: "B", status: "sent", attempts: 1, at: 6 });
  s.close();
}

describe("subscribers delete", () => {
  test("a confirmed address deletes once, normalized; the output never holds it", () => {
    seed();
    const first = run("delete", "Sub-A@Example.com");
    assert.deepEqual(first, { lines: ["deleted 1"], code: 0 });
    assert.deepEqual(run("delete", "sub-a@example.com"), { lines: ["deleted 0"], code: 0 });
    assert.equal(JSON.stringify(first).includes("sub-a"), false);
    assert.equal(countRows(path, "SELECT count(*) AS n FROM subscriptions WHERE id = 'A'"), 0);
    assert.equal(
      countRows(path, "SELECT count(*) AS n FROM deliveries WHERE subscription_id = 'A'"),
      0,
    );
    assert.equal(countRows(path, "SELECT count(*) AS n FROM deliveries"), 1);
    const wal = `${path}-wal`;
    assert.equal(existsSync(wal) ? statSync(wal).size : 0, 0);
    assert.equal(readFileSync(path).toString("latin1").includes("sub-a@example.com"), false);
    assert.equal(existsSync(`${path}.lock`), false);
  });

  test("a pending address deletes", () => {
    seed();
    assert.deepEqual(run("delete", " SUB-B@example.com\t"), { lines: ["deleted 1"], code: 0 });
    assert.equal(countRows(path, "SELECT count(*) AS n FROM subscriptions"), 1);
  });

  test("a missing store prints deleted 0 and creates no store", () => {
    assert.deepEqual(run("delete", "a@example.com"), { lines: ["deleted 0"], code: 0 });
    assert.deepEqual(readdirSync(dir), []);
  });

  test("a held lock exits 2 with the lock message and leaves the store unchanged", () => {
    seed();
    const lock = acquireLock(path, { ...testLockDeps(), pid: process.pid + 1 });
    try {
      const result = run("delete", "sub-a@example.com");
      assert.equal(result.code, 2);
      assert.equal(result.lines.length, 1);
      assert.match(
        result.lines[0] ?? "",
        /^pulse-notify: state file .*subs\.db is in use by test-host/,
      );
      assert.equal(result.lines.join("").includes("sub-a"), false);
      assert.equal(countRows(path, "SELECT count(*) AS n FROM subscriptions"), 2);
    } finally {
      lock.release();
    }
  });

  test("an invalid address exits 1", () => {
    assert.deepEqual(run("delete", "a@b"), {
      lines: ["pulse-notify: subscribers delete: invalid address"],
      code: 1,
    });
    assert.deepEqual(readdirSync(dir), []);
  });

  for (const args of [[], ["delete"], ["delete", "a@example.com", "b@example.com"], ["list"]]) {
    test(`arguments ${JSON.stringify(args)} print the usage`, () => {
      assert.deepEqual(run(...args), { lines: [USAGE], code: 1 });
    });
  }

  test("it works with subscriptions off: only the store path is needed", () => {
    seed();
    const result = runSubscribers(["delete", "sub-a@example.com"], {
      storePath: path,
      lock: testLockDeps(),
    });
    assert.deepEqual(result, { lines: ["deleted 1"], code: 0 });
  });
});
