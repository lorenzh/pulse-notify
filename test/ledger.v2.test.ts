import { Database } from "bun:sqlite";
import { afterAll, afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, type LedgerOptions } from "../src/ledger.ts";
import type { Notification } from "../src/types.ts";

const dir = mkdtempSync(join(tmpdir(), "notify-ledger2-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const open: Ledger[] = [];
afterEach(() => {
  for (const ledger of open.splice(0)) ledger.close();
});

/** Opens a ledger that is closed after the test. */
function ledgerAt(file: string, opts?: LedgerOptions): Ledger {
  const ledger = new Ledger(file, opts);
  open.push(ledger);
  return ledger;
}

let counter = 0;
function path(): string {
  return join(dir, `state-${counter++}.json`);
}

function note(key: string, incidentId = 1): Notification {
  return {
    key,
    event: "opened",
    incidentId,
    checkId: "c",
    checkName: "C",
    reason: null,
    time: "2026-01-01T00:00:00.000Z",
    timeMs: 0,
    openedMs: 0,
  };
}

/** A commit hook that throws while `isFailing` is set. */
function fault(): { isFailing: boolean; beforeCommit: () => void } {
  const f = {
    isFailing: false,
    beforeCommit: () => {
      if (f.isFailing) throw new Error("injected commit failure");
    },
  };
  return f;
}

const V2_FIXTURE = JSON.stringify({
  version: 2,
  channels: {
    c: {
      "1:opened": { status: "delivered", at: 10 },
      "2:opened": { status: "failed", at: 20 },
      "3:opened": { status: "pending", at: 30 },
      "4:opened": { status: "pending", at: 40 },
    },
    d: {},
  },
  payloads: { c: { "2:opened": note("2:opened", 2), "3:opened": note("3:opened", 3) } },
  remindersFrom: { c: 50 },
  manualFrom: { c: 60 },
});

test("a v1 file migrates, entries get the load time, and a v1 backup keeps its bytes", () => {
  const file = path();
  const v1 = JSON.stringify({
    version: 1,
    channels: { c: { "1:opened": "delivered", "2:opened": "failed" } },
  });
  writeFileSync(file, v1);
  const ledger = ledgerAt(file, { now: () => 5000 });
  assert.deepEqual(ledger.migration, {
    from: 1,
    entries: 2,
    backup: `${file}.v1.bak`,
  });
  assert.equal(ledger.status("c", "1:opened"), "delivered");
  assert.deepEqual(ledger.failed(), [{ channelId: "c", key: "2:opened", at: 5000 }]);
  assert.equal(readFileSync(`${file}.v1.bak`, "utf8"), v1);
  assert.equal(readFileSync(file).subarray(0, 15).toString(), "SQLite format 3");
});

test("a v2 file migrates statuses, times, payloads, marks and legacy pending entries", () => {
  const file = path();
  writeFileSync(file, V2_FIXTURE);
  const first = new Ledger(file);
  assert.deepEqual(first.migration, { from: 2, entries: 4, backup: `${file}.v2.bak` });
  first.close();
  assert.equal(readFileSync(`${file}.v2.bak`, "utf8"), V2_FIXTURE);

  const ledger = ledgerAt(file);
  assert.equal(ledger.migration, undefined, "a second open does not migrate again");
  assert.deepEqual(ledger.entries("c"), [
    ["1:opened", "delivered"],
    ["2:opened", "failed"],
    ["3:opened", "pending"],
    ["4:opened", "pending"],
  ]);
  assert.equal(ledger.hasChannel("d"), true);
  assert.deepEqual(ledger.failed(), [
    { channelId: "c", key: "2:opened", at: 20, notification: note("2:opened", 2) },
  ]);
  assert.deepEqual(ledger.pending(), [
    { channelId: "c", key: "3:opened", notification: note("3:opened", 3) },
    { channelId: "c", key: "4:opened" },
  ]);
  assert.equal(ledger.remindersFrom("c"), 50);
  assert.equal(ledger.manualFrom("c"), 60);
  assert.equal(ledger.checkRouting("c"), undefined);
  assert.equal(ledger.componentRouting("c"), undefined);
});

test("a crash before the publish leaves the JSON in place and the next open migrates", () => {
  const file = path();
  writeFileSync(file, V2_FIXTURE);
  assert.throws(
    () =>
      new Ledger(file, {
        hooks: {
          beforePublish: () => {
            throw new Error("crash");
          },
        },
      }),
    /crash/,
  );
  assert.equal(readFileSync(file, "utf8"), V2_FIXTURE);
  const ledger = ledgerAt(file);
  assert.equal(ledger.migration?.from, 2);
  assert.equal(ledger.status("c", "1:opened"), "delivered");
  assert.equal(existsSync(`${file}.migrating`), false);
});

/** A `-wal` of another database at `file`, holding the key `old:key`. */
function plantStaleWal(file: string): void {
  const other = path();
  const ledger = new Ledger(other);
  ledger.seed("c", ["old:key"]);
  // Copy the WAL while it still holds the seed, before close checkpoints it.
  writeFileSync(`${file}-wal`, readFileSync(`${other}-wal`));
  writeFileSync(`${file}-shm`, readFileSync(`${other}-shm`));
  ledger.close();
}

test("a stale WAL beside a fresh or JSON path is not replayed", () => {
  const fresh = path();
  plantStaleWal(fresh);
  const a = ledgerAt(fresh);
  a.seed("c", ["new:key"]);
  assert.deepEqual(a.entries("c"), [["new:key", "seeded"]]);
  a.close();
  assert.deepEqual(ledgerAt(fresh).entries("c"), [["new:key", "seeded"]]);

  const json = path();
  writeFileSync(
    json,
    JSON.stringify({ version: 2, channels: { c: { "1:opened": { status: "seeded", at: 1 } } } }),
  );
  plantStaleWal(json);
  assert.deepEqual(ledgerAt(json).entries("c"), [["1:opened", "seeded"]]);
});

test("a newer format or a bad entry is refused and the file is unchanged", () => {
  const file = path();
  for (const text of [
    JSON.stringify({ version: 3, channels: {} }),
    JSON.stringify({ version: 2, channels: { c: { k: "delivered" } } }),
    JSON.stringify({ version: 2, channels: { c: "x" } }),
  ]) {
    writeFileSync(file, text);
    assert.throws(() => new Ledger(file), /unsupported format/);
    assert.equal(readFileSync(file, "utf8"), text);
  }
});

/** A SQLite file built by `build`, with the bytes it had before any open. */
function sqliteFixture(build: (db: Database) => void): { file: string; bytes: Buffer } {
  const file = path();
  const db = new Database(file, { create: true });
  build(db);
  db.close();
  return { file, bytes: readFileSync(file) };
}

const SCHEMA_V3 = `
CREATE TABLE channels (id TEXT PRIMARY KEY, reminders_from INTEGER, manual_from INTEGER,
  check_routing TEXT, component_routing TEXT) STRICT;
CREATE TABLE entries (channel_id TEXT NOT NULL, key TEXT NOT NULL, status TEXT NOT NULL,
  at INTEGER NOT NULL, payload TEXT, recipients TEXT, PRIMARY KEY (channel_id, key)) STRICT;
PRAGMA user_version = 3;
INSERT INTO channels (id) VALUES ('c');
`;

test("hostile SQLite files are refused without a change", () => {
  const cases: [string, (db: Database) => void][] = [
    ["user_version 4", (db) => db.run(`${SCHEMA_V3} PRAGMA user_version = 4;`)],
    ["user_version 5", (db) => db.run(`${SCHEMA_V3} PRAGMA user_version = 5;`)],
    [
      "missing entries table",
      (db) => db.run("CREATE TABLE channels (id TEXT) STRICT; PRAGMA user_version = 3;"),
    ],
    [
      "status sent",
      (db) => db.run(`${SCHEMA_V3} INSERT INTO entries VALUES ('c', 'k', 'sent', 1, NULL, NULL);`),
    ],
    [
      "payload [1]",
      (db) =>
        db.run(`${SCHEMA_V3} INSERT INTO entries VALUES ('c', 'k', 'failed', 1, '[1]', NULL);`),
    ],
    [
      "malformed recipients",
      (db) =>
        db.run(
          `${SCHEMA_V3} INSERT INTO entries VALUES ('c', 'k', 'failed', 1, NULL, '{"delivered":"x"}');`,
        ),
    ],
  ];
  for (const [name, build] of cases) {
    const { file, bytes } = sqliteFixture(build);
    assert.throws(() => new Ledger(file), /unsupported format/, name);
    assert.deepEqual(readFileSync(file), bytes, name);
  }
});

test("bad rows are refused without a change, also from a committed WAL", () => {
  const entry = (recipients: string) =>
    `INSERT INTO entries VALUES ('c', 'k', 'failed', 1, NULL, '${recipients}');`;
  const channel = (check: string, component: string) =>
    `UPDATE channels SET check_routing = '${check}', component_routing = '${component}';`;
  const okCheck = '{"checks":[],"excludeChecks":[]}';
  const okComponent = '{"components":[],"excludeComponents":[]}';
  const cases: [string, string][] = [
    ["malformed recipients", entry('{"delivered":"x"}')],
    ["check routing {}", channel("{}", okComponent)],
    ["component routing {}", channel(okCheck, "{}")],
    ["check routing without excludeChecks", channel('{"checks":[]}', okComponent)],
    [
      "check routing with an extra list",
      channel('{"checks":[],"excludeChecks":[],"x":[]}', okComponent),
    ],
    ["check routing with component lists", channel(okComponent, okComponent)],
    ["check routing list of numbers", channel('{"checks":[1],"excludeChecks":[]}', okComponent)],
  ];
  for (const [name, sql] of cases) {
    const source = path();
    const writer = new Database(source, { create: true });
    writer.run("PRAGMA journal_mode = WAL");
    writer.run("PRAGMA wal_autocheckpoint = 0");
    writer.run(`${SCHEMA_V3} ${sql}`);
    const file = path();
    // Copy while the writer is open, so the rows sit only in the copied WAL.
    writeFileSync(file, readFileSync(source));
    writeFileSync(`${file}-wal`, readFileSync(`${source}-wal`));
    writer.close();
    const bytes = readFileSync(file);
    const wal = readFileSync(`${file}-wal`);
    assert.ok(wal.length > 0, name);
    assert.throws(() => new Ledger(file), /unsupported format/, name);
    assert.deepEqual(readFileSync(file), bytes, name);
    assert.deepEqual(readFileSync(`${file}-wal`), wal, name);
  }
});

test("a well-formed routing fingerprint opens", () => {
  const { file } = sqliteFixture((db) =>
    db.run(
      `${SCHEMA_V3} UPDATE channels SET check_routing = '{"checks":["a"],"excludeChecks":[]}', component_routing = '{"components":[],"excludeComponents":["b"]}';`,
    ),
  );
  const ledger = ledgerAt(file);
  assert.equal(ledger.checkRouting("c"), '{"checks":["a"],"excludeChecks":[]}');
  assert.equal(ledger.componentRouting("c"), '{"components":[],"excludeComponents":["b"]}');
});

test("each mutation is on disk when it returns, with no flush", () => {
  const file = path();
  let clock = 1234;
  const ledger = ledgerAt(file, { now: () => clock });
  ledger.claim("c", "1:opened", note("1:opened"));
  ledger.claim("c", "2:opened", note("2:opened"));
  clock = 2000;
  ledger.settle("c", "1:opened", "delivered");
  ledger.settle("c", "2:opened", "failed");
  ledger.setRemindersFrom("c", 77);
  const saved = new Ledger(file);
  assert.equal(saved.status("c", "1:opened"), "delivered");
  // A delivered key loses its payload; a failed key keeps it for a resend.
  assert.deepEqual(saved.failed(), [
    { channelId: "c", key: "2:opened", at: 2000, notification: note("2:opened") },
  ]);
  assert.equal(saved.remindersFrom("c"), 77);
  saved.close();
});

test("a planted .migrating symlink is removed, not written through", () => {
  const file = path();
  const victim = `${file}.victim`;
  writeFileSync(victim, "DO_NOT_OVERWRITE");
  symlinkSync(victim, `${file}.migrating`);
  writeFileSync(file, V2_FIXTURE);
  const ledger = ledgerAt(file);
  ledger.claim("c", "9:opened", note("9:opened"));
  assert.equal(readFileSync(victim, "utf8"), "DO_NOT_OVERWRITE");
  assert.equal(existsSync(`${file}.migrating`), false);
  assert.equal(lstatSync(file).isSymbolicLink(), false);
});

test("prune removes old settled entries and payloads, never pending", () => {
  const file = path();
  let clock = 1_000;
  const ledger = ledgerAt(file, { now: () => clock });
  ledger.seed("c", ["1:opened", "other"]);
  ledger.claim("c", "2:opened", note("2:opened", 2));
  ledger.claim("c", "3:opened", note("3:opened", 3));
  ledger.settle("c", "3:opened", "failed");
  ledger.claim("c", "4:opened", note("4:opened", 4));
  clock = 10_000;
  // Incident 1 is still visible; 3 is not.
  assert.equal(ledger.prune(5_000, new Set([1])), 2); // "other" and 3:opened
  assert.equal(ledger.has("c", "other"), false);
  assert.equal(ledger.has("c", "3:opened"), false);
  assert.equal(ledger.has("c", "1:opened"), true, "visible incident key stays");
  assert.equal(ledger.status("c", "2:opened"), "pending");
  assert.equal(ledger.status("c", "4:opened"), "pending");
  assert.deepEqual(ledger.failed(), []);
  assert.equal(ledger.hasChannel("c"), true);
  // Not old enough: nothing is removed.
  assert.equal(ledger.prune(60_000, new Set()), 0);
  const saved = ledgerAt(file);
  assert.deepEqual(saved.entries("c"), [
    ["1:opened", "seeded"],
    ["2:opened", "pending"],
    ["4:opened", "pending"],
  ]);
});

test("prune keeps every incident key until a poll has shown the visible incidents", () => {
  let clock = 0;
  const ledger = ledgerAt(path(), { now: () => clock });
  ledger.seed("c", ["1:opened", "x"]);
  clock = 100_000;
  assert.equal(ledger.prune(1, undefined), 1);
  assert.equal(ledger.has("c", "1:opened"), true);
});

test("a failed prune or reminder mark write changes nothing", () => {
  const file = path();
  let clock = 0;
  const f = fault();
  const ledger = ledgerAt(file, { now: () => clock, hooks: f });
  ledger.seed("c", ["x"], { remindersFrom: 50 });
  clock = 100;
  f.isFailing = true;
  assert.throws(() => ledger.prune(10, new Set()), /injected/);
  assert.throws(() => ledger.setRemindersFrom("c", undefined), /injected/);
  assert.equal(ledger.has("c", "x"), true);
  assert.equal(ledger.remindersFrom("c"), 50);
  f.isFailing = false;
  assert.equal(ledger.prune(10, new Set()), 1);
  ledger.setRemindersFrom("c", undefined);
  const saved = ledgerAt(file);
  assert.deepEqual(saved.entries("c"), []);
  assert.equal(saved.remindersFrom("c"), undefined);
});

test("resend sets a failed key back to pending and keeps its payload", () => {
  const file = path();
  const ledger = ledgerAt(file);
  ledger.claim("c", "1:opened", note("1:opened"));
  ledger.settle("c", "1:opened", "failed");
  assert.equal(ledger.resend("c", "9:opened"), "not-failed");
  assert.equal(ledger.resend("c", "1:opened"), "resent");
  assert.deepEqual(ledgerAt(file).pending(), [
    { channelId: "c", key: "1:opened", notification: note("1:opened") },
  ]);
  assert.equal(ledger.resend("c", "1:opened"), "not-failed");
});

test("resend of a failed key without a payload is refused", () => {
  const file = path();
  writeFileSync(file, JSON.stringify({ version: 1, channels: { c: { "1:opened": "failed" } } }));
  const ledger = ledgerAt(file);
  assert.equal(ledger.resend("c", "1:opened"), "no-payload");
  assert.equal(ledger.status("c", "1:opened"), "failed");
});

test("a failed seed, claim, resend or setRecipients changes neither memory nor disk", () => {
  const file = path();
  const f = fault();
  const ledger = ledgerAt(file, { hooks: f });
  const reminder = (n: number): Notification => ({
    ...note(`1:reminder:${n}`),
    event: "reminder",
  });
  ledger.claim("c", "1:reminder:1", reminder(1));
  ledger.settle("c", "1:reminder:1", "delivered");
  ledger.claim("c", "2:opened", note("2:opened"));
  ledger.claim("c", "3:opened", note("3:opened"));
  ledger.settle("c", "3:opened", "failed");
  f.isFailing = true;
  assert.throws(() => ledger.claim("c", "1:reminder:2", reminder(2)), /injected/);
  assert.throws(() => ledger.seed("c", ["z"], { remindersFrom: 7, manualFrom: 7 }), /injected/);
  assert.throws(() => ledger.seed("new", []), /injected/);
  assert.throws(() => ledger.resend("c", "3:opened"), /injected/);
  assert.throws(
    () => ledger.setRecipients("c", "2:opened", { delivered: ["a"], refused: [] }),
    /injected/,
  );
  const expected = [
    ["1:reminder:1", "delivered"],
    ["2:opened", "pending"],
    ["3:opened", "failed"],
  ];
  for (const view of [ledger, ledgerAt(file)]) {
    assert.deepEqual(view.entries("c"), expected);
    assert.equal(view.remindersFrom("c"), undefined);
    assert.equal(view.manualFrom("c"), undefined);
    assert.equal(view.hasChannel("new"), false);
    assert.deepEqual(view.pending(), [
      { channelId: "c", key: "2:opened", notification: note("2:opened") },
    ]);
  }
  f.isFailing = false;
  ledger.claim("c", "1:reminder:2", reminder(2));
  assert.equal(ledgerAt(file).status("c", "1:reminder:2"), "pending");
  assert.equal(ledgerAt(file).has("c", "1:reminder:1"), false, "older reminder pruned");
});

test("setRecipients survives a reopen and pending keeps the claim order", () => {
  const file = path();
  const ledger = ledgerAt(file);
  ledger.claim("b", "2:opened", note("2:opened"));
  ledger.claim("a", "1:opened", note("1:opened"));
  ledger.claim("b", "3:opened", note("3:opened"));
  ledger.setRecipients("b", "3:opened", { delivered: ["x@example.test"], refused: ["y@e.test"] });
  ledger.close();
  assert.deepEqual(ledgerAt(file).pending(), [
    { channelId: "b", key: "2:opened", notification: note("2:opened") },
    {
      channelId: "b",
      key: "3:opened",
      notification: note("3:opened"),
      recipients: { delivered: ["x@example.test"], refused: ["y@e.test"] },
    },
    { channelId: "a", key: "1:opened", notification: note("1:opened") },
  ]);
});

test("seed stores routing fingerprints with the keys", () => {
  const file = path();
  const ledger = ledgerAt(file);
  ledger.seed("c", ["1:opened"], {
    checkRouting: '{"checks":["api"],"excludeChecks":[]}',
    componentRouting: '{"components":[],"excludeComponents":[]}',
  });
  ledger.close();
  const saved = ledgerAt(file);
  assert.equal(saved.checkRouting("c"), '{"checks":["api"],"excludeChecks":[]}');
  assert.equal(saved.componentRouting("c"), '{"components":[],"excludeComponents":[]}');
  assert.equal(saved.status("c", "1:opened"), "seeded");
});

test("manualFrom round-trips, survives prune and drops a non-number value", () => {
  const file = path();
  let clock = 0;
  const ledger = new Ledger(file, { now: () => clock });
  ledger.seed("c", ["manual:1:opened"], { manualFrom: 40 });
  assert.equal(ledger.manualFrom("c"), 40);
  clock = 100;
  ledger.prune(10, new Set(), new Set());
  ledger.close();
  const reopened = new Ledger(file);
  assert.equal(reopened.manualFrom("c"), 40);
  reopened.close();
  writeFileSync(
    file,
    JSON.stringify({
      version: 2,
      channels: { a: {}, b: {}, c: {} },
      manualFrom: { a: "40", b: null, c: 7 },
    }),
  );
  const loaded = ledgerAt(file);
  assert.equal(loaded.manualFrom("a"), undefined);
  assert.equal(loaded.manualFrom("b"), undefined);
  assert.equal(loaded.manualFrom("c"), 7);
});

test("manualFrom of a v1 file is ignored", () => {
  const file = path();
  writeFileSync(file, JSON.stringify({ version: 1, channels: { c: {} }, manualFrom: { c: 5 } }));
  assert.equal(ledgerAt(file).manualFrom("c"), undefined);
});
