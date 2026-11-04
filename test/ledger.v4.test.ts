import { Database } from "bun:sqlite";
import { afterAll, afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, type LedgerOptions } from "../src/ledger.ts";
import type { Notification } from "../src/types.ts";

const dir = mkdtempSync(join(tmpdir(), "notify-ledger4-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const open: Ledger[] = [];
afterEach(() => {
  for (const ledger of open.splice(0)) ledger.close();
});

function ledgerAt(file: string, opts?: LedgerOptions): Ledger {
  const ledger = new Ledger(file, opts);
  open.push(ledger);
  return ledger;
}

let counter = 0;
function path(): string {
  return join(dir, `state-${counter++}.json`);
}

function note(key: string, event = "opened"): Notification {
  // Trust boundary of the test: a warning event is stored as an opaque payload here.
  return {
    key,
    event,
    incidentId: 1,
    checkId: "c",
    checkName: "C",
    reason: null,
    time: "2026-01-01T00:00:00.000Z",
    timeMs: 0,
    openedMs: 0,
  } as Notification;
}

const SCHEMA_V3 = `
CREATE TABLE channels (id TEXT PRIMARY KEY, reminders_from INTEGER, manual_from INTEGER,
  check_routing TEXT, component_routing TEXT) STRICT;
CREATE TABLE entries (channel_id TEXT NOT NULL, key TEXT NOT NULL, status TEXT NOT NULL,
  at INTEGER NOT NULL, payload TEXT, recipients TEXT, PRIMARY KEY (channel_id, key)) STRICT;
PRAGMA user_version = 3;
`;

const ROWS_V3 = `
INSERT INTO channels (id, reminders_from, manual_from, check_routing, component_routing)
  VALUES ('c', 5, 6, '{"checks":["a"],"excludeChecks":[]}', NULL), ('d', NULL, NULL, NULL, NULL);
INSERT INTO entries VALUES ('c', '1:opened', 'delivered', 10, NULL, NULL);
INSERT INTO entries VALUES ('c', '2:opened', 'failed', 20, '${JSON.stringify(note("2:opened"))}',
  '{"delivered":["x@example.com"],"refused":[]}');
INSERT INTO entries VALUES ('c', '3:opened', 'pending', 30, '${JSON.stringify(note("3:opened"))}', NULL);
`;

/** A format-4 schema without CHECK constraints, so a hostile row can be stored. */
const LOOSE_V4 = `${SCHEMA_V3}
CREATE TABLE alert_state (kind TEXT, subject_id TEXT, last_event_at INTEGER, stage INTEGER,
  episode_at INTEGER, observed_at INTEGER, updated_at INTEGER);
PRAGMA user_version = 4;
`;

function fixture(sql: string): string {
  const file = path();
  const db = new Database(file, { create: true });
  db.run(sql);
  db.close();
  return file;
}

/** Reads a file with its own connection, not through `Ledger`. */
function inspect(file: string): { version: unknown; entries: [string, string][] } {
  const db = new Database(file, { readonly: true });
  try {
    const row = db.query("PRAGMA user_version").get() as { user_version: number };
    const table = db.query("SELECT name FROM sqlite_master WHERE name = 'entries'").get();
    if (table === null) return { version: row.user_version, entries: [] };
    const entries = db
      .query("SELECT key, status FROM entries ORDER BY key")
      .all()
      .map((r) => {
        const { key, status } = r as { key: string; status: string };
        return [key, status] as [string, string];
      });
    return { version: row.user_version, entries };
  } finally {
    db.close();
  }
}

/** Entries of the file read on its own connection; 0 when it has no entries table yet. */
function entryCount(file: string): number {
  const db = new Database(file, { readonly: true });
  try {
    const table = db.query("SELECT name FROM sqlite_master WHERE name = 'entries'").get();
    if (table === null) return 0;
    const row = db.query("SELECT count(*) AS n FROM entries").get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

/** A format-3 file whose three entries sit only in its committed WAL. */
function walFixture(extra = ""): string {
  const source = path();
  const writer = new Database(source, { create: true });
  writer.run("PRAGMA journal_mode = WAL");
  writer.run("PRAGMA wal_autocheckpoint = 0");
  writer.run(`${SCHEMA_V3} ${ROWS_V3} ${extra}`);
  const file = path();
  writeFileSync(file, readFileSync(source));
  writeFileSync(`${file}-wal`, readFileSync(`${source}-wal`));
  writer.close();
  chmodSync(file, 0o600);
  // Precondition: the main file alone has no entry.
  const alone = path();
  writeFileSync(alone, readFileSync(file));
  assert.equal(entryCount(alone), 0);
  return file;
}

const THREE: [string, string][] = [
  ["1:opened", "delivered"],
  ["2:opened", "failed"],
  ["3:opened", "pending"],
];

function walBytes(file: string): number {
  return existsSync(`${file}-wal`) ? statSync(`${file}-wal`).size : 0;
}

function crash(): never {
  throw new Error("simulated crash");
}

test("a valid format-3 file migrates to format 4 with every record and a private backup", () => {
  const file = fixture(SCHEMA_V3 + ROWS_V3);
  const ledger = ledgerAt(file);
  assert.deepEqual(ledger.migration, { from: 3, entries: 3, backup: `${file}.v3.bak` });
  assert.equal(inspect(file).version, 4);
  assert.equal(inspect(`${file}.v3.bak`).version, 3);
  assert.equal(statSync(`${file}.v3.bak`).mode & 0o777, 0o600);
  assert.deepEqual(ledger.entries("c"), THREE);
  assert.equal(ledger.hasChannel("d"), true);
  assert.equal(ledger.remindersFrom("c"), 5);
  assert.equal(ledger.manualFrom("c"), 6);
  assert.equal(ledger.checkRouting("c"), '{"checks":["a"],"excludeChecks":[]}');
  assert.equal(ledger.componentRouting("c"), undefined);
  assert.deepEqual(ledger.failed(), [
    {
      channelId: "c",
      key: "2:opened",
      at: 20,
      notification: note("2:opened"),
      recipients: { delivered: ["x@example.com"], refused: [] },
    },
  ]);
  assert.deepEqual(ledger.pending(), [
    { channelId: "c", key: "3:opened", notification: note("3:opened") },
  ]);
  ledger.close();
  assert.equal(ledgerAt(file).migration, undefined);
});

test("a JSON ledger migrates directly to format 4", () => {
  const file = path();
  writeFileSync(
    file,
    JSON.stringify({ version: 2, channels: { c: { "1:opened": { status: "delivered", at: 1 } } } }),
  );
  const ledger = ledgerAt(file);
  assert.equal(ledger.migration?.from, 2);
  assert.equal(inspect(file).version, 4);
  assert.deepEqual(ledger.entries("c"), [["1:opened", "delivered"]]);
});

test("bad format-3 and format-4 files are refused with their bytes unchanged", () => {
  const cases: [string, string][] = [
    [
      "format 3 with status sent",
      `${SCHEMA_V3} INSERT INTO channels (id) VALUES ('c'); INSERT INTO entries VALUES ('c', 'k', 'sent', 1, NULL, NULL);`,
    ],
    ["format 4 without alert_state", `${SCHEMA_V3} PRAGMA user_version = 4;`],
    ["user_version 5", `${SCHEMA_V3} PRAGMA user_version = 5;`],
    ["stage 7", `${LOOSE_V4} INSERT INTO alert_state VALUES ('expiry', 'x', NULL, 7, 1, 1, 1);`],
    ["kind x", `${LOOSE_V4} INSERT INTO alert_state VALUES ('x', 'a', 1, NULL, NULL, NULL, 1);`],
    [
      "no updated_at",
      `${LOOSE_V4} INSERT INTO alert_state VALUES ('budget-check', 'a', 1, NULL, NULL, NULL, NULL);`,
    ],
  ];
  for (const [name, sql] of cases) {
    const file = fixture(sql);
    const bytes = readFileSync(file);
    assert.throws(() => new Ledger(file), /unsupported format/, name);
    assert.deepEqual(readFileSync(file), bytes, name);
    assert.equal(existsSync(`${file}.v3.bak`), false, name);
  }
});

test("a backup symlink becomes a private regular file and its target is untouched", () => {
  const file = fixture(SCHEMA_V3 + ROWS_V3);
  const victim = `${file}.victim`;
  writeFileSync(victim, "DO_NOT_OVERWRITE");
  chmodSync(victim, 0o644);
  symlinkSync(victim, `${file}.v3.bak`);
  ledgerAt(file);
  assert.equal(lstatSync(`${file}.v3.bak`).isSymbolicLink(), false);
  assert.equal(lstatSync(`${file}.v3.bak`).mode & 0o777, 0o600);
  assert.equal(inspect(`${file}.v3.bak`).entries.length, 3);
  assert.equal(readFileSync(victim, "utf8"), "DO_NOT_OVERWRITE");
  assert.equal(statSync(victim).mode & 0o777, 0o644);
});

test("committed WAL survives sidecar crash", () => {
  const file = walFixture();
  const backup = `${file}.v3.bak`;
  assert.throws(() => new Ledger(file, { hooks: { afterSidecars: crash } }), /simulated crash/);
  assert.equal(walBytes(file), 0);
  assert.equal(inspect(file).entries.length, 3);
  assert.equal(inspect(backup).entries.length, 3);
  assert.deepEqual(inspect(file), { version: 3, entries: THREE });
  assert.deepEqual(inspect(backup), { version: 3, entries: THREE });
  // Repeated interrupted opens keep the rows in the source and the backup.
  for (let i = 0; i < 2; i++) {
    assert.throws(() => new Ledger(file, { hooks: { afterSidecars: crash } }), /simulated crash/);
    assert.equal(inspect(backup).entries.length, 3);
    assert.equal(inspect(file).entries.length, 3);
  }
  const ledger = ledgerAt(file);
  assert.equal(ledger.migration?.from, 3);
  assert.deepEqual(inspect(file), { version: 4, entries: THREE });
  assert.deepEqual(ledger.entries("c"), THREE);
  assert.equal(inspect(backup).entries.length, 3);
});

test("committed WAL survives a crash before publish", () => {
  const file = walFixture();
  assert.throws(() => new Ledger(file, { hooks: { beforePublish: crash } }), /simulated crash/);
  assert.equal(existsSync(`${file}.migrating`), true);
  const ledger = ledgerAt(file);
  assert.equal(existsSync(`${file}.migrating`), false);
  assert.deepEqual(inspect(file), { version: 4, entries: THREE });
  assert.deepEqual(ledger.entries("c"), THREE);
  assert.equal(inspect(`${file}.v3.bak`).entries.length, 3);
});

test("a blocked checkpoint fails the open and deletes nothing", () => {
  const file = walFixture();
  const reader = new Database(file, { readwrite: true });
  try {
    reader.run("BEGIN");
    reader.query("SELECT count(*) FROM entries").get();
    assert.throws(() => new Ledger(file), /ledger checkpoint was blocked/);
    assert.equal(existsSync(`${file}.v3.bak`), false);
    assert.equal(existsSync(`${file}.migrating`), false);
    reader.run("COMMIT");
  } finally {
    reader.close();
  }
  assert.equal(inspect(file).entries.length, 3);
});

test("a hostile row only in the WAL is refused and the main file and WAL keep their bytes", () => {
  const file = walFixture("INSERT INTO entries VALUES ('c', '4:opened', 'sent', 40, NULL, NULL);");
  const bytes = readFileSync(file);
  const wal = readFileSync(`${file}-wal`);
  assert.throws(() => new Ledger(file), /unsupported format/);
  assert.deepEqual(readFileSync(file), bytes);
  assert.deepEqual(readFileSync(`${file}-wal`), wal);
  assert.equal(existsSync(`${file}.v3.bak`), false);
});

/** A commit hook that throws while `isFailing` is set and counts its calls. */
function fault(): { isFailing: boolean; calls: number; beforeCommit: () => void } {
  const f = {
    isFailing: false,
    calls: 0,
    beforeCommit: () => {
      f.calls++;
      if (f.isFailing) throw new Error("injected commit failure");
    },
  };
  return f;
}

test("a failed alert batch changes no row and no entry, in memory and on disk", () => {
  const file = path();
  const f = fault();
  const ledger = ledgerAt(file, { now: () => 1000, hooks: f });
  f.isFailing = true;
  const key = "budget:check:1000:abc";
  assert.throws(() =>
    ledger.applyAlerts(
      [{ kind: "budget-check", subjectId: "a", state: { lastEventAt: 1000 } }],
      [
        { channelId: "w1", key, notification: note(key, "budget-low") },
        { channelId: "w2", key, notification: note(key, "budget-low") },
      ],
    ),
  );
  assert.equal(ledger.alertState("budget-check", "a"), undefined);
  assert.deepEqual(ledger.pending(), []);
  ledger.close();
  const again = ledgerAt(file);
  assert.deepEqual(again.alertStates("budget-check"), []);
  assert.deepEqual(again.pending(), []);
});

test("alert batches survive a reopen, also an observed_at-only advance", () => {
  const file = path();
  let clock = 1000;
  const f = fault();
  const ledger = ledgerAt(file, { now: () => clock, hooks: f });
  assert.deepEqual(ledger.applyAlerts([], []), []);
  assert.equal(f.calls, 0);
  const key = "expiry:500:14:abc";
  const added = ledger.applyAlerts(
    [{ kind: "expiry", subjectId: "x", state: { stage: 14, episodeAt: 500, observedAt: 900 } }],
    [
      { channelId: "w1", key, notification: note(key, "tls-expiry") },
      { channelId: "w1", key, notification: note(key, "tls-expiry") },
    ],
  );
  assert.deepEqual(
    added.map((d) => [d.channelId, d.key]),
    [["w1", key]],
  );
  // A key the channel already has is not added again.
  assert.deepEqual(
    ledger.applyAlerts([], [{ channelId: "w1", key, notification: note(key, "tls-expiry") }]),
    [],
  );
  clock = 61_000;
  ledger.applyAlerts(
    [{ kind: "expiry", subjectId: "x", state: { stage: 14, episodeAt: 500, observedAt: 60_900 } }],
    [],
  );
  f.isFailing = true;
  assert.throws(() =>
    ledger.applyAlerts(
      [
        {
          kind: "expiry",
          subjectId: "x",
          state: { stage: 14, episodeAt: 500, observedAt: 120_900 },
        },
      ],
      [],
    ),
  );
  assert.deepEqual(ledger.alertState("expiry", "x"), {
    lastEventAt: undefined,
    stage: 14,
    episodeAt: 500,
    observedAt: 60_900,
    updatedAt: 61_000,
  });
  ledger.close();
  const again = ledgerAt(file);
  assert.deepEqual(again.alertStates("expiry"), [
    [
      "x",
      { lastEventAt: undefined, stage: 14, episodeAt: 500, observedAt: 60_900, updatedAt: 61_000 },
    ],
  ]);
  assert.deepEqual(again.pending(), [
    { channelId: "w1", key, notification: note(key, "tls-expiry") },
  ]);
});

function dropFixture(file: string, opts?: LedgerOptions): Ledger {
  const ledger = ledgerAt(file, opts);
  for (const ch of ["w1", "w2"]) {
    ledger.claim(ch, "1:opened", note("1:opened"));
    ledger.claim(ch, "manual:2:opened", note("manual:2:opened"));
    ledger.setRecipients(ch, "1:opened", { delivered: ["a@example.com"], refused: [] });
    ledger.claim(ch, "budget:check:1:h", note("budget:check:1:h", "budget-low"));
    ledger.claim(ch, "3:opened", note("3:opened"));
    ledger.settle(ch, "3:opened", "failed");
  }
  ledger.claim("w2", "4:reminder:1", note("4:reminder:1", "reminder"));
  ledger.claim("other", "5:opened", note("5:opened"));
  return ledger;
}

test("dropping pending incidents is all or nothing over every given channel", () => {
  const file = path();
  const f = fault();
  let ledger = dropFixture(file, { now: () => 7, hooks: f });
  const before = ledger.pending();
  f.isFailing = true;
  assert.throws(() => ledger.dropPendingIncidents(["w1", "w2"]), /injected commit failure/);
  assert.deepEqual(ledger.pending(), before);
  ledger.close();
  ledger = ledgerAt(file, { now: () => 7 });
  assert.deepEqual(ledger.pending(), before);
  assert.deepEqual(
    [...ledger.dropPendingIncidents(["w1", "w2"])],
    [
      ["w1", 2],
      ["w2", 3],
    ],
  );
  ledger.close();
  ledger = ledgerAt(file, { now: () => 7 });
  assert.deepEqual(
    ledger.pending().map((p) => [p.channelId, p.key]),
    [
      ["w1", "budget:check:1:h"],
      ["w2", "budget:check:1:h"],
      ["other", "5:opened"],
    ],
  );
  assert.equal(ledger.status("w1", "1:opened"), "dropped");
  assert.equal(ledger.status("w2", "4:reminder:1"), "dropped");
  assert.deepEqual(
    ledger.failed().map((e) => [e.channelId, e.key]),
    [
      ["w1", "3:opened"],
      ["w2", "3:opened"],
    ],
  );
  const db = new Database(file, { readonly: true });
  const row = db
    .query(
      "SELECT at, payload, recipients FROM entries WHERE channel_id = 'w1' AND key = '1:opened'",
    )
    .get();
  db.close();
  assert.deepEqual(row, { at: 7, payload: null, recipients: null });
});

test("dropping with nothing to drop writes nothing", () => {
  const f = fault();
  const ledger = ledgerAt(path(), { hooks: f });
  ledger.claim("w1", "budget:check:1:h", note("budget:check:1:h", "budget-low"));
  const calls = f.calls;
  assert.deepEqual(
    [...ledger.dropPendingIncidents(["w1", "none"])],
    [
      ["w1", 0],
      ["none", 0],
    ],
  );
  assert.equal(f.calls, calls);
});

const DAY = 86_400_000;
const T0 = 1_000_000;

test("alert-state pruning removes only old rows absent from a good feed read", () => {
  const cases: [string, Parameters<Ledger["pruneAlerts"]>[1], string, boolean][] = [
    ["checks lacks gone", { checks: new Set(["other"]) }, "budget-check", false],
    ["checks lists gone", { checks: new Set(["gone"]) }, "budget-check", true],
    ["no checks read", {}, "budget-check", true],
    ["components 404", { checks: new Set() }, "budget-component", true],
    ["expiry absent", { checks: new Set() }, "expiry", false],
  ];
  for (const [name, presence, kind, isKept] of cases) {
    let clock = T0;
    const ledger = ledgerAt(path(), { now: () => clock });
    ledger.applyAlerts(
      [
        { kind: "budget-check", subjectId: "gone", state: { lastEventAt: T0 } },
        { kind: "budget-component", subjectId: "gone", state: { lastEventAt: T0 } },
        { kind: "expiry", subjectId: "gone", state: { stage: 14, episodeAt: T0, observedAt: T0 } },
      ],
      [],
    );
    clock = T0 + 2 * DAY;
    ledger.pruneAlerts(DAY, presence);
    assert.equal(ledger.alertState(kind as "expiry", "gone") !== undefined, isKept, name);
  }
});

test("a recent alert row stays and pruning a budget entry keeps its alert row", () => {
  let clock = T0;
  const file = path();
  const ledger = ledgerAt(file, { now: () => clock });
  const key = "budget:check:1000000:h";
  ledger.applyAlerts(
    [{ kind: "budget-check", subjectId: "a", state: { lastEventAt: T0 } }],
    [{ channelId: "w", key, notification: note(key, "budget-low") }],
  );
  ledger.settle("w", key, "delivered");
  clock = T0 + DAY / 2;
  assert.equal(ledger.pruneAlerts(DAY, { checks: new Set() }), 0);
  clock = T0 + 2 * DAY;
  assert.equal(ledger.prune(DAY, new Set()), 1);
  assert.equal(ledger.has("w", key), false);
  assert.equal(ledger.alertState("budget-check", "a")?.lastEventAt, T0);
  ledger.close();
  assert.equal(ledgerAt(file).alertState("budget-check", "a")?.lastEventAt, T0);
  assert.deepEqual(
    readdirSync(dir).filter((n) => n.endsWith(".migrating")),
    [],
  );
});

/** A WAL-mode file with `sql` committed only in its WAL, copied with its `-wal` and `-shm`. */
function sidecarFixture(sql: string): string {
  const source = path();
  const writer = new Database(source, { create: true });
  writer.run("PRAGMA journal_mode = WAL");
  writer.run("PRAGMA wal_autocheckpoint = 0");
  writer.run(sql);
  const file = path();
  for (const suffix of ["", "-wal", "-shm"]) {
    writeFileSync(`${file}${suffix}`, readFileSync(`${source}${suffix}`));
  }
  writer.close();
  return file;
}

test("a refused file keeps the bytes of its main file, WAL and SHM", () => {
  const cases: [string, string][] = [
    [
      "format 3 with status sent",
      `${SCHEMA_V3} INSERT INTO channels (id) VALUES ('c'); INSERT INTO entries VALUES ('c', 'k', 'sent', 1, NULL, NULL);`,
    ],
    ["format 4 without alert_state", `${SCHEMA_V3} PRAGMA user_version = 4;`],
    ["user_version 5", `${SCHEMA_V3} PRAGMA user_version = 5;`],
    ["stage 7", `${LOOSE_V4} INSERT INTO alert_state VALUES ('expiry', 'x', NULL, 7, 1, 1, 1);`],
    ["kind x", `${LOOSE_V4} INSERT INTO alert_state VALUES ('x', 'a', 1, NULL, NULL, NULL, 1);`],
  ];
  for (const [name, sql] of cases) {
    const file = sidecarFixture(sql);
    const before = ["", "-wal", "-shm"].map((s) => readFileSync(`${file}${s}`));
    assert.throws(() => new Ledger(file), /unsupported format/, name);
    ["", "-wal", "-shm"].forEach((s, i) => {
      assert.deepEqual(readFileSync(`${file}${s}`), before[i], `${name} ${s || "main"}`);
    });
    assert.equal(existsSync(`${file}.v3.bak`), false, name);
  }
});
