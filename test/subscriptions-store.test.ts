import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StartupError } from "@lorenzh/pulse-kit";
import { SubscriberStore, startCleanup } from "../src/subscriber-store.ts";
import {
  countRows,
  fakeScheduler,
  manualClock,
  readStore,
  tempDir,
} from "./subscriptions-support.ts";

const DAY = 86_400_000;
let dir: string;
let remove: () => void;
let path: string;
let store: SubscriberStore | undefined;

beforeEach(() => {
  ({ dir, remove } = tempDir("notify-subs-store-"));
  path = join(dir, "subs.db");
});

afterEach(() => {
  try {
    store?.close();
  } catch {
    // Already closed by the test.
  }
  store = undefined;
  remove();
});

function openStore(): SubscriberStore {
  store = SubscriberStore.open(path);
  return store;
}

function addConfirmed(s: SubscriberStore, id: string, email: string, at: number): void {
  s.insertPending({ id, email, now: at, digest: `d-${id}`, expiresAt: at + DAY });
  assert.equal(s.confirm(id, at), true);
}

/** The `-wal` size; SQLite removes the file on a clean close, which counts as 0. */
const walSize = (): number => (existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0);

describe("schema", () => {
  test("a new store is private, WAL, FULL, secure_delete and version 1", () => {
    const s = openStore();
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(s.pragmas(), { journalMode: "wal", synchronous: 2, secureDelete: 1 });
    const tables = readStore(path, (db) => {
      const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
      const names = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all()
        .map((r) => r.name);
      return { version: version?.user_version, names };
    });
    assert.deepEqual(tables, {
      version: 1,
      names: ["deliveries", "events", "meta", "subscriptions"],
    });
  });

  test("constraints of R3 hold", () => {
    openStore().close();
    store = undefined;
    const db = new Database(path);
    try {
      assert.throws(() =>
        db.run(
          "INSERT INTO subscriptions (id, email, state, created_at, confirm_sends) VALUES ('a', 'a@example.com', 'other', 0, 0)",
        ),
      );
      db.run(
        "INSERT INTO subscriptions (id, email, state, created_at, confirm_sends) VALUES ('a', 'a@example.com', 'pending', 0, 0)",
      );
      assert.throws(() =>
        db.run(
          "INSERT INTO subscriptions (id, email, state, created_at, confirm_sends) VALUES ('b', 'a@example.com', 'pending', 0, 0)",
        ),
      );
      assert.throws(() =>
        db.run("INSERT INTO events (key, manual_id, status, detected_at) VALUES ('k', 1, 'x', 0)"),
      );
      assert.throws(() =>
        db.run(
          "INSERT INTO deliveries (event_key, subscription_id, status, attempts, at) VALUES ('k', 'a', 'x', 1, 0)",
        ),
      );
    } finally {
      db.close();
    }
  });

  test("a new event has passes 0 and next_pass_at NULL", () => {
    const s = openStore();
    s.addPendingEvents([{ key: "manual:1:opened", manualId: 1, payload: "{}" }], 5);
    const row = readStore(path, (db) =>
      db
        .query("SELECT status, passes, next_pass_at FROM events WHERE key = 'manual:1:opened'")
        .get(),
    );
    assert.deepEqual(row, { status: "pending", passes: 0, next_pass_at: null });
  });

  test("a file of another version is refused", () => {
    const db = new Database(path, { create: true });
    db.run("PRAGMA user_version = 2");
    db.close();
    assert.throws(
      () => SubscriberStore.open(path),
      (err: unknown) =>
        err instanceof StartupError && err.setting === "PULSE_NOTIFY_SUBSCRIPTIONS_STATE",
    );
  });

  test("an existing file of version 0 is refused", () => {
    writeFileSync(path, "");
    assert.throws(() => SubscriberStore.open(path), StartupError);
  });

  test("a reopened store keeps its rows", () => {
    addConfirmed(openStore(), "a1", "a@example.com", 1);
    store?.close();
    const s = openStore();
    assert.equal(s.subscriptionById("a1")?.state, "confirmed");
  });
});

describe("subscriptions", () => {
  test("pending, renew, confirm and lookups", () => {
    const s = openStore();
    s.insertPending({
      id: "a1",
      email: "a@example.com",
      now: 10,
      digest: "d1",
      expiresAt: 10 + DAY,
    });
    assert.deepEqual(s.subscriptionByEmail("a@example.com"), {
      id: "a1",
      email: "a@example.com",
      state: "pending",
      createdAt: 10,
      confirmDigest: "d1",
      confirmExpiresAt: 10 + DAY,
      confirmSends: 1,
      lastSentAt: 10,
      confirmedAt: null,
    });
    assert.equal(
      s.renewPending("a1", { now: 600010, digest: "d2", expiresAt: 600010 + DAY }),
      true,
    );
    assert.equal(s.subscriptionByDigest("d1"), undefined);
    const renewed = s.subscriptionByDigest("d2");
    assert.equal(renewed?.confirmSends, 2);
    assert.equal(renewed?.lastSentAt, 600010);
    assert.deepEqual(s.counts(), { total: 1, pending: 1 });
    assert.equal(s.confirm("a1", 700000), true);
    assert.equal(s.confirm("a1", 800000), false);
    assert.equal(s.subscriptionById("a1")?.confirmedAt, 700000);
    assert.equal(s.renewPending("a1", { now: 1, digest: "d3", expiresAt: 2 }), false);
    assert.deepEqual(s.counts(), { total: 1, pending: 0 });
  });

  test("a failing mutation rolls back as one transaction", () => {
    const s = openStore();
    assert.throws(() =>
      s.transaction(() => {
        s.insertPending({ id: "a1", email: "a@example.com", now: 1, digest: "d1", expiresAt: 2 });
        s.insertPending({ id: "a2", email: "a@example.com", now: 1, digest: "d2", expiresAt: 2 });
      }),
    );
    assert.equal(countRows(path, "SELECT count(*) AS n FROM subscriptions"), 0);
  });
});

describe("events and deliveries", () => {
  test("seeding sets the baseline in one transaction", () => {
    const s = openStore();
    assert.equal(s.metaValue("manual_baseline_at"), undefined);
    s.seedEvents([{ key: "manual:1:opened", manualId: 1 }], 42);
    assert.equal(s.metaValue("manual_baseline_at"), "42");
    assert.equal(s.hasEvent("manual:1:opened"), true);
    assert.equal(s.event("manual:1:opened")?.status, "seeded");
    assert.deepEqual(s.pendingEvents(), []);
  });

  test("pending events in detected_at, key order with pass fields", () => {
    const s = openStore();
    s.addPendingEvents([{ key: "b", manualId: 2, payload: "{}" }], 5);
    s.addPendingEvents(
      [
        { key: "c", manualId: 3, payload: "{}" },
        { key: "a", manualId: 1, payload: "{}" },
      ],
      9,
    );
    assert.deepEqual(
      s.pendingEvents().map((e) => e.key),
      ["b", "a", "c"],
    );
    assert.equal(s.startPass("b"), 1);
    assert.equal(s.startPass("b"), 2);
    s.setNextPassAt("b", 1234);
    assert.deepEqual(
      readStore(path, (db) =>
        db.query("SELECT passes, next_pass_at FROM events WHERE key = 'b'").get(),
      ),
      { passes: 2, next_pass_at: 1234 },
    );
    s.markDone("b", 77);
    assert.equal(s.event("b")?.settledAt, 77);
    assert.deepEqual(
      s.pendingEvents().map((e) => e.key),
      ["a", "c"],
    );
  });

  test("eligible ids: confirmed before detection, without a delivery, in pages by id", () => {
    const s = openStore();
    for (let i = 0; i < 5; i++) addConfirmed(s, `id${i}`, `a${i}@example.com`, 1);
    addConfirmed(s, "late", "late@example.com", 100);
    s.insertPending({ id: "pend", email: "p@example.com", now: 1, digest: "dp", expiresAt: DAY });
    s.addPendingEvents([{ key: "E1", manualId: 1, payload: "{}" }], 50);
    assert.equal(
      s.completeDelivery({
        eventKey: "E1",
        subscriptionId: "id1",
        status: "sent",
        attempts: 1,
        at: 60,
      }),
      true,
    );
    assert.deepEqual(s.eligibleIds("E1", "", 2), ["id0", "id2"]);
    assert.deepEqual(s.eligibleIds("E1", "id2", 2), ["id3", "id4"]);
    assert.deepEqual(s.eligibleIds("E1", "id4", 2), []);
  });

  test("the completion write inserts only while the subscription exists (D21)", () => {
    const s = openStore();
    addConfirmed(s, "A", "a@example.com", 1);
    s.addPendingEvents([{ key: "E1", manualId: 1, payload: "{}" }], 5);
    assert.equal(s.deleteSubscription("A"), true);
    assert.equal(
      s.completeDelivery({
        eventKey: "E1",
        subscriptionId: "A",
        status: "sent",
        attempts: 1,
        at: 9,
      }),
      false,
    );
    assert.equal(countRows(path, "SELECT count(*) AS n FROM deliveries"), 0);
  });

  test("finalize writes failed rows for current eligible subscriptions and sets done", () => {
    const s = openStore();
    addConfirmed(s, "A", "a@example.com", 1);
    addConfirmed(s, "B", "b@example.com", 1);
    addConfirmed(s, "C", "c@example.com", 1);
    s.addPendingEvents([{ key: "E1", manualId: 1, payload: "{}" }], 5);
    s.completeDelivery({ eventKey: "E1", subscriptionId: "B", status: "sent", attempts: 1, at: 6 });
    s.startPass("E1");
    s.startPass("E1");
    s.deleteSubscription("C");
    assert.equal(s.finalizeEvent("E1", 99), 1);
    assert.deepEqual(
      readStore(path, (db) =>
        db
          .query(
            "SELECT subscription_id, status, attempts, at FROM deliveries ORDER BY subscription_id",
          )
          .all(),
      ),
      [
        { subscription_id: "A", status: "failed", attempts: 2, at: 99 },
        { subscription_id: "B", status: "sent", attempts: 1, at: 6 },
      ],
    );
    assert.equal(s.event("E1")?.status, "done");
    assert.equal(
      countRows(
        path,
        "SELECT count(*) AS n FROM deliveries d WHERE NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.id = d.subscription_id)",
      ),
      0,
    );
  });
});

describe("deletion leaves no trace", () => {
  test("a deleted row is gone in a second connection, the WAL is empty and the bytes are clean", () => {
    const s = openStore();
    addConfirmed(s, "A-id-1", "erase-me@example.com", 1);
    addConfirmed(s, "B-id-2", "keep@example.com", 1);
    s.addPendingEvents([{ key: "E1", manualId: 1, payload: "{}" }], 5);
    s.completeDelivery({
      eventKey: "E1",
      subscriptionId: "A-id-1",
      status: "sent",
      attempts: 1,
      at: 6,
    });
    assert.equal(s.deleteSubscription("A-id-1"), true);
    assert.equal(s.deleteSubscription("A-id-1"), false);
    assert.equal(
      countRows(path, "SELECT count(*) AS n FROM subscriptions WHERE id = ?", "A-id-1"),
      0,
    );
    assert.equal(
      countRows(path, "SELECT count(*) AS n FROM deliveries WHERE subscription_id = ?", "A-id-1"),
      0,
    );
    assert.equal(walSize(), 0);
    const bytes = readFileSync(path).toString("latin1");
    assert.equal(bytes.includes("erase-me@example.com"), false);
    assert.equal(bytes.includes("keep@example.com"), true);
  });

  test("a busy checkpoint warns without data and is retried at cleanup", () => {
    const warnings: { message: string; fields: unknown }[] = [];
    store = SubscriberStore.open(path, {
      logger: { warn: (message, fields) => warnings.push({ message, fields }) },
    });
    const s = store;
    addConfirmed(s, "A", "busy@example.com", 1);
    const reader = new Database(path, { readonly: true });
    reader.run("BEGIN");
    reader.query("SELECT count(*) FROM subscriptions").get();
    s.deleteSubscription("A");
    assert.equal(warnings.length, 1);
    assert.equal(JSON.stringify(warnings).includes("busy@example.com"), false);
    assert.ok(walSize() > 0);
    reader.run("COMMIT");
    reader.close();
    s.cleanup({ now: 1, retentionMs: DAY, listedIds: undefined });
    assert.equal(walSize(), 0);
    assert.equal(warnings.length, 1);
  });

  test("close checkpoints the WAL", () => {
    const s = openStore();
    addConfirmed(s, "A", "a@example.com", 1);
    s.close();
    store = undefined;
    assert.equal(walSize(), 0);
  });
});

describe("cleanup", () => {
  test("cleanup boundaries on its own timer, with no poll at all", () => {
    const clock = manualClock(0);
    const timers = fakeScheduler(clock);
    const s = openStore();
    // Last confirmation mail at t=1, so confirm_expires_at = 86400001.
    s.insertPending({ id: "P", email: "p@example.com", now: 1, digest: "dP", expiresAt: 86400001 });
    addConfirmed(s, "C", "c@example.com", 0);
    const deleted: string[][] = [];
    const cleanup = startCleanup({
      store: s,
      now: clock.now,
      retentionMs: 30 * DAY,
      listedIds: () => undefined,
      onDeleted: (ids) => deleted.push([...ids]),
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      logError: () => assert.fail("no error"),
    });
    timers.advanceTo(86400000);
    assert.equal(countRows(path, "SELECT count(*) AS n FROM subscriptions WHERE id = 'P'"), 1);
    assert.deepEqual(deleted, []);
    timers.advanceTo(90000000);
    assert.equal(
      countRows(path, "SELECT count(*) AS n FROM subscriptions WHERE email = 'p@example.com'"),
      0,
    );
    assert.deepEqual(deleted, [["P"]]);
    assert.equal(walSize(), 0);
    timers.advanceTo(10 * 86400000);
    assert.equal(countRows(path, "SELECT count(*) AS n FROM subscriptions WHERE id = 'C'"), 1);
    assert.equal(timers.pending(), 1);
    cleanup.stop();
    assert.equal(timers.pending(), 0);
  });

  test("cleanup runs once at start", () => {
    const clock = manualClock(100);
    const timers = fakeScheduler(clock);
    const s = openStore();
    s.insertPending({ id: "P", email: "p@example.com", now: 1, digest: "dP", expiresAt: 100 });
    const deleted: string[] = [];
    startCleanup({
      store: s,
      now: clock.now,
      retentionMs: DAY,
      listedIds: () => undefined,
      onDeleted: (ids) => deleted.push(...ids),
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      logError: () => assert.fail("no error"),
    }).stop();
    assert.deepEqual(deleted, ["P"]);
  });

  test("a failing cleanup logs its error name and keeps its timer", () => {
    const clock = manualClock(0);
    const timers = fakeScheduler(clock);
    const s = openStore();
    s.close();
    store = undefined;
    const errors: string[] = [];
    const cleanup = startCleanup({
      store: s,
      now: clock.now,
      retentionMs: DAY,
      listedIds: () => undefined,
      onDeleted: () => assert.fail("nothing deleted"),
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      logError: (message) => errors.push(message),
    });
    assert.deepEqual(errors, ["subscriber cleanup failed"]);
    assert.equal(timers.pending(), 1);
    cleanup.stop();
  });

  test("retention never prunes pending or listed events, nor before a good read", () => {
    const s = openStore();
    addConfirmed(s, "A", "a@example.com", 0);
    s.seedEvents([{ key: "seeded-old", manualId: 1 }], 0);
    s.addPendingEvents(
      [
        { key: "pending-old", manualId: 2, payload: "{}" },
        { key: "done-old", manualId: 3, payload: "{}" },
        { key: "done-listed", manualId: 4, payload: "{}" },
        { key: "done-new", manualId: 5, payload: "{}" },
      ],
      0,
    );
    s.markDone("done-old", 0);
    s.markDone("done-listed", 0);
    s.markDone("done-new", 25 * DAY);
    s.completeDelivery({
      eventKey: "done-old",
      subscriptionId: "A",
      status: "sent",
      attempts: 1,
      at: 0,
    });
    const now = 30 * DAY + 1;
    s.cleanup({ now, retentionMs: 30 * DAY, listedIds: undefined });
    assert.equal(countRows(path, "SELECT count(*) AS n FROM events"), 5);
    s.cleanup({ now, retentionMs: 30 * DAY, listedIds: new Set([4]) });
    assert.deepEqual(
      readStore(path, (db) =>
        db
          .query<{ key: string }, []>("SELECT key FROM events ORDER BY key")
          .all()
          .map((r) => r.key),
      ),
      ["done-listed", "done-new", "pending-old"],
    );
    assert.equal(countRows(path, "SELECT count(*) AS n FROM deliveries"), 0);
    assert.equal(countRows(path, "SELECT count(*) AS n FROM subscriptions"), 1);
  });
});

describe("deletion inside an enclosing transaction", () => {
  const cases: { name: string; remove: (s: SubscriberStore) => void }[] = [
    { name: "deleteSubscription", remove: (s) => assert.equal(s.deleteSubscription("A"), true) },
    { name: "deleteByEmail", remove: (s) => assert.equal(s.deleteByEmail("a@example.com"), 1) },
    {
      name: "cleanup",
      remove: (s) =>
        assert.deepEqual(s.cleanup({ now: 10 * DAY, retentionMs: DAY, listedIds: undefined }), [
          "A",
        ]),
    },
  ];
  for (const c of cases) {
    test(`${c.name} composes with a replacement insert and checkpoints after commit`, () => {
      const s = openStore();
      s.insertPending({ id: "A", email: "a@example.com", now: 1, digest: "d-A", expiresAt: 2 });
      s.transaction(() => {
        c.remove(s);
        s.insertPending({
          id: "B",
          email: "a@example.com",
          now: 10 * DAY,
          digest: "d-B",
          expiresAt: 11 * DAY,
        });
      });
      assert.equal(s.subscriptionByEmail("a@example.com")?.id, "B");
      assert.equal(walSize(), 0);
    });
  }
});
