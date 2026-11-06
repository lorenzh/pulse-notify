import { Database } from "bun:sqlite";
import { afterAll, afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, type LedgerOptions, LedgerRowError } from "../src/ledger.ts";

const dir = mkdtempSync(join(tmpdir(), "notify-ledger5-"));
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
  return join(dir, `state-${counter++}`);
}

function crash(): never {
  throw new Error("simulated crash");
}

const NOTE_2 =
  '{"key":"2:opened","event":"opened","incidentId":2,"checkId":"c","checkName":"C","reason":null,"time":"2026-01-01T00:00:00.000Z","timeMs":0,"openedMs":0}';

const SCHEMA_V4 = `
CREATE TABLE channels (id TEXT PRIMARY KEY, reminders_from INTEGER, manual_from INTEGER,
  check_routing TEXT, component_routing TEXT) STRICT;
CREATE TABLE entries (channel_id TEXT NOT NULL, key TEXT NOT NULL, status TEXT NOT NULL,
  at INTEGER NOT NULL, payload TEXT, recipients TEXT, PRIMARY KEY (channel_id, key)) STRICT;
CREATE TABLE alert_state (kind TEXT NOT NULL, subject_id TEXT NOT NULL, last_event_at INTEGER,
  stage INTEGER, episode_at INTEGER, observed_at INTEGER, updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, subject_id)) STRICT;
`;

const ROWS_V4 = `
INSERT INTO channels VALUES ('c', 5, 6, '{"checks":["a"],"excludeChecks":[]}', NULL);
INSERT INTO entries VALUES ('c', '1:opened', 'delivered', 10, NULL, NULL);
INSERT INTO entries VALUES ('c', '2:opened', 'failed', 20, '${NOTE_2}',
  '{"delivered":["x@example.com"],"refused":["y@example.com"]}');
INSERT INTO entries VALUES ('c', '3:opened', 'seeded', 30, NULL, NULL);
INSERT INTO alert_state VALUES ('budget-check', 'api', 1000, NULL, NULL, NULL, 1001);
INSERT INTO alert_state VALUES ('expiry', 'web', NULL, 14, 2000, 2001, 2002);
PRAGMA user_version = 4;
`;

/** A format-5 schema without CHECK constraints, so a hostile row can be stored. */
const LOOSE_V5 = `${SCHEMA_V4}
CREATE TABLE remote_channels (id TEXT, definition TEXT, revision TEXT, applied_at INTEGER);
CREATE TABLE resend_commands (id TEXT, channel_id TEXT, key TEXT, state TEXT, posted_state TEXT,
  updated_at INTEGER);
PRAGMA user_version = 5;
`;

const REV_1 = `sha256-${"1".repeat(64)}`;
const REV_2 = `sha256-${"2".repeat(64)}`;
const HOOK_A = '{"id":"a","type":"webhook","urlEnv":"PULSE_NOTIFY_SECRET_A"}';
const SENTINEL = "https://sentinel-secret.invalid/hook";

function fixture(sql: string): string {
  const file = path();
  const db = new Database(file, { create: true });
  db.run(sql);
  db.close();
  chmodSync(file, 0o600);
  return file;
}

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

/** Every row of every table, read on its own connection, not through `Ledger`. */
function dump(file: string): Record<string, unknown> {
  const db = new Database(file, { readonly: true });
  try {
    const out: Record<string, unknown> = {
      version: (db.query("PRAGMA user_version").get() as { user_version: number }).user_version,
    };
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    for (const { name } of tables) out[name] = db.query(`SELECT * FROM ${name}`).all();
    return out;
  } finally {
    db.close();
  }
}

const V4_ROWS = {
  channels: [
    {
      id: "c",
      reminders_from: 5,
      manual_from: 6,
      check_routing: '{"checks":["a"],"excludeChecks":[]}',
      component_routing: null,
    },
  ],
  entries: [
    {
      channel_id: "c",
      key: "1:opened",
      status: "delivered",
      at: 10,
      payload: null,
      recipients: null,
    },
    {
      channel_id: "c",
      key: "2:opened",
      status: "failed",
      at: 20,
      payload: NOTE_2,
      recipients: '{"delivered":["x@example.com"],"refused":["y@example.com"]}',
    },
    { channel_id: "c", key: "3:opened", status: "seeded", at: 30, payload: null, recipients: null },
  ],
  alert_state: [
    {
      kind: "budget-check",
      subject_id: "api",
      last_event_at: 1000,
      stage: null,
      episode_at: null,
      observed_at: null,
      updated_at: 1001,
    },
    {
      kind: "expiry",
      subject_id: "web",
      last_event_at: null,
      stage: 14,
      episode_at: 2000,
      observed_at: 2001,
      updated_at: 2002,
    },
  ],
};

test("a valid format-4 file migrates to format 5 with every row and a private v4 backup", () => {
  const file = fixture(SCHEMA_V4 + ROWS_V4);
  const ledger = ledgerAt(file);
  assert.deepEqual(ledger.migration, { from: 4, entries: 3, backup: `${file}.v4.bak` });
  assert.deepEqual(dump(file), {
    version: 5,
    ...V4_ROWS,
    remote_channels: [],
    resend_commands: [],
  });
  assert.deepEqual(dump(`${file}.v4.bak`), { version: 4, ...V4_ROWS });
  assert.equal(statSync(`${file}.v4.bak`).mode & 0o777, 0o600);
  assert.equal(ledger.remindersFrom("c"), 5);
  assert.equal(ledger.manualFrom("c"), 6);
  assert.deepEqual(ledger.failed(), [
    {
      channelId: "c",
      key: "2:opened",
      at: 20,
      notification: JSON.parse(NOTE_2),
      recipients: { delivered: ["x@example.com"], refused: ["y@example.com"] },
    },
  ]);
  assert.deepEqual(ledger.alertState("budget-check", "api"), {
    lastEventAt: 1000,
    stage: undefined,
    episodeAt: undefined,
    observedAt: undefined,
    updatedAt: 1001,
  });
  assert.deepEqual(ledger.alertState("expiry", "web"), {
    lastEventAt: undefined,
    stage: 14,
    episodeAt: 2000,
    observedAt: 2001,
    updatedAt: 2002,
  });
  assert.deepEqual(ledger.remoteChannels(), []);
  assert.deepEqual(ledger.resendCommands(), []);
  ledger.close();
  assert.equal(ledgerAt(file).migration, undefined);
});

test("a crash during the format-4 migration keeps the format-4 file and the next open migrates", () => {
  for (const hook of ["afterSidecars", "beforePublish"] as const) {
    const file = fixture(SCHEMA_V4 + ROWS_V4);
    assert.throws(() => new Ledger(file, { hooks: { [hook]: crash } }), /simulated crash/, hook);
    assert.deepEqual(dump(file), { version: 4, ...V4_ROWS }, hook);
    const ledger = ledgerAt(file);
    assert.equal(ledger.migration?.from, 4, hook);
    assert.deepEqual(dump(file), {
      version: 5,
      ...V4_ROWS,
      remote_channels: [],
      resend_commands: [],
    });
    assert.equal(dump(`${file}.v4.bak`).version, 4, hook);
  }
});

test("a v4 backup symlink becomes a private regular file and its target is untouched", () => {
  const file = fixture(SCHEMA_V4 + ROWS_V4);
  const victim = `${file}.victim`;
  writeFileSync(victim, "DO_NOT_OVERWRITE");
  chmodSync(victim, 0o644);
  symlinkSync(victim, `${file}.v4.bak`);
  ledgerAt(file);
  assert.equal(lstatSync(`${file}.v4.bak`).isSymbolicLink(), false);
  assert.equal(lstatSync(`${file}.v4.bak`).mode & 0o777, 0o600);
  assert.equal(readFileSync(victim, "utf8"), "DO_NOT_OVERWRITE");
  assert.equal(statSync(victim).mode & 0o777, 0o644);
});

test("a bad format-5 file is refused with its main, WAL and SHM bytes unchanged", () => {
  const cases: [string, string][] = [
    [
      "resend state queued",
      `${LOOSE_V5} INSERT INTO resend_commands VALUES ('r1', 'a', 'k', 'queued', NULL, 1);`,
    ],
    [
      "posted state queued",
      `${LOOSE_V5} INSERT INTO resend_commands VALUES ('r1', 'a', 'k', 'failed', 'queued', 1);`,
    ],
    [
      "remote row with a literal url",
      `${LOOSE_V5} INSERT INTO remote_channels VALUES ('a', '{"id":"a","type":"webhook","url":"${SENTINEL}"}', '${REV_1}', 1);`,
    ],
    [
      "remote row with another id",
      `${LOOSE_V5} INSERT INTO remote_channels VALUES ('b', '${HOOK_A}', '${REV_1}', 1);`,
    ],
    [
      "remote row with a bad revision",
      `${LOOSE_V5} INSERT INTO remote_channels VALUES ('a', '${HOOK_A}', 'r1', 1);`,
    ],
    [
      "remote_channels missing",
      `${SCHEMA_V4} CREATE TABLE resend_commands (id TEXT); PRAGMA user_version = 5;`,
    ],
    [
      "resend_commands missing",
      `${SCHEMA_V4} CREATE TABLE remote_channels (id TEXT); PRAGMA user_version = 5;`,
    ],
  ];
  for (const [name, sql] of cases) {
    const file = sidecarFixture(sql);
    const before = ["", "-wal", "-shm"].map((s) => readFileSync(`${file}${s}`));
    assert.throws(() => new Ledger(file), /unsupported format/, name);
    ["", "-wal", "-shm"].forEach((s, i) => {
      assert.deepEqual(readFileSync(`${file}${s}`), before[i], `${name} ${s || "main"}`);
    });
  }
});

test("remote channel rows persist references only and keep their own revision", () => {
  const file = path();
  const ledger = ledgerAt(file, { now: () => 1 });
  const hookB = '{"id":"b","type":"slack","urlFile":"b.url"}';
  ledger.replaceRemoteChannels([
    { id: "a", definition: HOOK_A, revision: REV_2, appliedAt: 200 },
    { id: "b", definition: hookB, revision: REV_1, appliedAt: 100 },
  ]);
  assert.throws(
    () =>
      ledger.replaceRemoteChannels([
        {
          id: "a",
          definition: `{"id":"a","type":"webhook","url":"${SENTINEL}"}`,
          revision: REV_2,
          appliedAt: 300,
        },
      ]),
    (err: unknown) => err instanceof LedgerRowError && !err.message.includes(SENTINEL),
  );
  ledger.close();
  assert.deepEqual(ledgerAt(file).remoteChannels(), [
    { id: "a", definition: HOOK_A, revision: REV_2, appliedAt: 200 },
    { id: "b", definition: hookB, revision: REV_1, appliedAt: 100 },
  ]);
  for (const suffix of ["", "-wal"]) {
    if (existsSync(`${file}${suffix}`)) {
      assert.equal(readFileSync(`${file}${suffix}`).includes(SENTINEL), false, suffix);
    }
  }
});

test("the prune deletes only posted finished commands older than 7 days", () => {
  const now = 1_000_000_000_000;
  const week = 604_800_000;
  const file = fixture(`${SCHEMA_V4}
CREATE TABLE remote_channels (id TEXT PRIMARY KEY, definition TEXT NOT NULL,
  revision TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT;
CREATE TABLE resend_commands (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, key TEXT NOT NULL,
  state TEXT NOT NULL, posted_state TEXT, updated_at INTEGER NOT NULL) STRICT;
INSERT INTO resend_commands VALUES ('unposted', 'a', 'k', 'delivered', NULL, ${now - week - 1});
INSERT INTO resend_commands VALUES ('admitted', 'a', 'k', 'admitted', 'admitted', ${now - week - 1});
INSERT INTO resend_commands VALUES ('edge', 'a', 'k', 'failed', 'failed', ${now - week});
INSERT INTO resend_commands VALUES ('old', 'a', 'k', 'delivered', 'delivered', ${now - week - 1});
PRAGMA user_version = 5;`);
  const ledger = ledgerAt(file, { now: () => now });
  assert.equal(ledger.pruneResendCommands(), 1);
  assert.deepEqual(
    ledger.resendCommands().map((r) => r.id),
    ["unposted", "admitted", "edge"],
  );
  ledger.close();
  assert.deepEqual(
    ledgerAt(file)
      .resendCommands()
      .map((r) => r.id),
    ["unposted", "admitted", "edge"],
  );
});

const RESEND_NOTE = {
  key: "1:opened",
  event: "opened" as const,
  incidentId: 1,
  checkId: "example",
  checkName: "Example site",
  reason: null,
  time: "2026-01-01T00:00:00.000Z",
  timeMs: 0,
  openedMs: 0,
};

/** A failed `a/1:opened`, admitted by `cmd-1`, plus a second admitted row `cmd-2` of the same key. */
function twoAdmitted(file: string): void {
  const ledger = new Ledger(file, { now: () => 5 });
  ledger.claim("a", "1:opened", RESEND_NOTE);
  ledger.settle("a", "1:opened", "failed");
  assert.equal(
    ledger.admitResendCommand({ id: "cmd-1", channelId: "a", key: "1:opened" }, true).row.state,
    "admitted",
  );
  ledger.close();
  const db = new Database(file);
  db.run("INSERT INTO resend_commands VALUES ('cmd-2', 'a', '1:opened', 'admitted', NULL, 6)");
  db.close();
}

test("the terminal write of an entry and of every admitted command of its key share one transaction", () => {
  for (const status of ["delivered", "failed", "dropped"] as const) {
    const file = path();
    twoAdmitted(file);
    let isBroken = true;
    const ledger = ledgerAt(file, {
      now: () => 9,
      hooks: {
        beforeCommit: () => {
          if (isBroken) throw new Error("disk full");
        },
      },
    });
    assert.throws(() => ledger.settle("a", "1:opened", status), /disk full/);
    assert.equal(ledger.status("a", "1:opened"), "pending");
    assert.deepEqual(
      ledger.resendCommands().map((r) => [r.id, r.state]),
      [
        ["cmd-1", "admitted"],
        ["cmd-2", "admitted"],
      ],
    );
    isBroken = false;
    ledger.settle("a", "1:opened", status);
    ledger.close();
    const again = ledgerAt(file);
    assert.equal(again.status("a", "1:opened"), status);
    assert.deepEqual(
      again.resendCommands().map((r) => [r.id, r.state, r.updatedAt]),
      [
        ["cmd-1", status, 9],
        ["cmd-2", status, 9],
      ],
    );
  }
});

test("a stale reminder resend is admitted, then dropped, and its command ends dropped", () => {
  const ledger = ledgerAt(path(), { now: () => 5 });
  const key = "1:reminder:2";
  ledger.claim("a", key, { ...RESEND_NOTE, key, event: "reminder" as const });
  ledger.settle("a", key, "failed");
  const admitted = ledger.admitResendCommand({ id: "cmd-r", channelId: "a", key }, true);
  assert.deepEqual([admitted.isNew, admitted.row.state], [true, "admitted"]);
  assert.equal(ledger.status("a", key), "pending");
  ledger.settle("a", key, "dropped");
  assert.deepEqual(
    ledger.resendCommands().map((r) => [r.id, r.state]),
    [["cmd-r", "dropped"]],
  );
  assert.deepEqual(ledger.failed(), []);
});
