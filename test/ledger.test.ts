import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Ledger, LedgerClosedError } from "../src/ledger.ts";
import type { Notification } from "../src/types.ts";

function note(key: string): Notification {
  return {
    key,
    event: "opened",
    incidentId: 1,
    checkId: "c",
    checkName: "C",
    reason: null,
    time: "2026-01-01T00:00:00.000Z",
    timeMs: 0,
    openedMs: 0,
  };
}

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), "notify-ledger-")), "sub", "state.json");
}

test("state persists across instances", async () => {
  const path = tmpPath();
  const a = new Ledger(path);
  assert.equal(a.hasChannel("c"), false);
  a.seed("c", ["1:opened"]);
  assert.equal(a.claim("c", "2:opened", note("2:opened")), true);
  assert.equal(a.claim("c", "3:opened", note("3:opened")), true);
  a.settle("c", "3:opened", "delivered");
  assert.equal(a.claim("c", "4:opened", note("4:opened")), true);
  a.settle("c", "4:opened", "failed");
  await a.flush();

  const b = new Ledger(path);
  assert.equal(b.hasChannel("c"), true);
  assert.equal(b.hasChannel("other"), false);
  assert.equal(b.status("c", "1:opened"), "seeded");
  assert.equal(b.status("c", "2:opened"), "pending");
  assert.equal(b.status("c", "3:opened"), "delivered");
  assert.equal(b.status("c", "4:opened"), "failed");
  assert.deepEqual(b.pending(), [
    { channelId: "c", key: "2:opened", notification: note("2:opened") },
  ]);
});

test("claim refuses a recorded key and settle needs a pending claim", () => {
  const ledger = new Ledger(tmpPath());
  assert.equal(ledger.claim("c", "k", note("k")), true);
  assert.equal(ledger.claim("c", "k", note("k")), false);
  ledger.settle("c", "k", "delivered");
  assert.throws(() => ledger.settle("c", "k", "failed"));
  assert.throws(() => ledger.settle("c", "unknown", "failed"));
});

test("seeding an empty list still creates the channel", () => {
  const path = tmpPath();
  new Ledger(path).seed("c", []);
  assert.equal(new Ledger(path).hasChannel("c"), true);
});

test("a corrupt ledger is an error, not an empty state", () => {
  const path = tmpPath();
  new Ledger(path).seed("c", []);
  writeFileSync(path, "{bad");
  assert.throws(() => new Ledger(path));
  writeFileSync(path, JSON.stringify({ version: 3, channels: {} }));
  assert.throws(() => new Ledger(path), /unsupported format/);
});

test("settle removes the payload; a ledger without payloads loads", () => {
  const path = tmpPath();
  const a = new Ledger(path);
  a.claim("c", "1:opened", note("1:opened"));
  a.settle("c", "1:opened", "delivered");
  a.close();
  const db = new Database(path, { readonly: true });
  assert.deepEqual(db.query("SELECT key, payload, recipients FROM entries").all(), [
    { key: "1:opened", payload: null, recipients: null },
  ]);
  db.close();
  assert.deepEqual(new Ledger(path).pending(), []);

  const legacy = tmpPath();
  mkdirSync(dirname(legacy), { recursive: true });
  writeFileSync(legacy, JSON.stringify({ version: 1, channels: { c: { "9:opened": "pending" } } }));
  assert.deepEqual(new Ledger(legacy).pending(), [{ channelId: "c", key: "9:opened" }]);
});

test("format 5 has the exact schema, user_version 5 and WAL mode", () => {
  const path = tmpPath();
  const ledger = new Ledger(path);
  ledger.close();
  const db = new Database(path, { readonly: true });
  const sql = db
    .query("SELECT sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) =>
      String((row as { sql: string }).sql)
        .replace(/\s+/g, " ")
        .trim(),
    );
  assert.deepEqual(sql, [
    "CREATE TABLE alert_state ( kind TEXT NOT NULL CHECK (kind IN ('budget-check','budget-component','expiry')), subject_id TEXT NOT NULL, last_event_at INTEGER, stage INTEGER CHECK (stage IN (14, 3)), episode_at INTEGER, observed_at INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (kind, subject_id) ) STRICT",
    "CREATE TABLE channels ( id TEXT PRIMARY KEY, reminders_from INTEGER, manual_from INTEGER, check_routing TEXT, component_routing TEXT ) STRICT",
    "CREATE TABLE entries ( channel_id TEXT NOT NULL, key TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('seeded','pending','delivered','failed','dropped')), at INTEGER NOT NULL, payload TEXT, recipients TEXT, PRIMARY KEY (channel_id, key) ) STRICT",
    "CREATE TABLE remote_channels ( id TEXT PRIMARY KEY, definition TEXT NOT NULL, revision TEXT NOT NULL, applied_at INTEGER NOT NULL ) STRICT",
    "CREATE TABLE resend_commands ( id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, key TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('admitted','delivered','failed','dropped','not-failed','no-payload','channel-unavailable')), posted_state TEXT CHECK (posted_state IS NULL OR posted_state IN ('admitted','delivered','failed','dropped','not-failed','no-payload','channel-unavailable')), updated_at INTEGER NOT NULL ) STRICT",
  ]);
  assert.deepEqual(db.query("PRAGMA user_version").get(), { user_version: 5 });
  assert.deepEqual(db.query("PRAGMA journal_mode").get(), { journal_mode: "wal" });
  db.close();
});

test("after close a claim throws LedgerClosedError and writes nothing", () => {
  const path = tmpPath();
  const ledger = new Ledger(path);
  ledger.seed("c", []);
  ledger.close();
  assert.throws(() => ledger.claim("c", "1:opened", note("1:opened")), LedgerClosedError);
  assert.throws(() => ledger.seed("c", ["x"]), { name: "LedgerClosedError" });
  const reopened = new Ledger(path);
  assert.deepEqual(reopened.entries("c"), []);
  reopened.close();
});

test("flush checkpoints the WAL down to 0 bytes", async () => {
  const path = tmpPath();
  const ledger = new Ledger(path);
  ledger.claim("c", "1:opened", note("1:opened"));
  assert.ok(statSync(`${path}-wal`).size > 0);
  await ledger.flush();
  assert.equal(statSync(`${path}-wal`).size, 0);
  ledger.close();
});

test("on an open ledger an equal reminder mark and a prune without candidate write nothing", () => {
  let commits = 0;
  const ledger = new Ledger(tmpPath(), {
    now: () => 1000,
    hooks: {
      beforeCommit: () => {
        commits += 1;
      },
    },
  });
  ledger.seed("c", ["1:opened"]);
  ledger.setRemindersFrom("c", 500);
  commits = 0;
  assert.equal(ledger.setRemindersFrom("c", 500), undefined);
  assert.equal(ledger.setRemindersFrom("absent", undefined), undefined);
  assert.equal(ledger.prune(1, undefined), 0);
  assert.equal(commits, 0);
  assert.equal(ledger.remindersFrom("c"), 500);
  ledger.close();
});

test("prune keeps listed manual ids, negative and 0 included", () => {
  const day = 86_400_000;
  const t0 = Date.UTC(2026, 0, 1);
  let clock = t0;
  const ledger = new Ledger(tmpPath(), { now: () => clock });
  ledger.seed("c", ["manual:-9:opened", "manual:0:opened", "manual:9:opened", "manual:-90:opened"]);
  clock = t0 + 2 * day;
  assert.equal(ledger.prune(day, new Set(), new Set([-9, 0])), 2);
  assert.deepEqual(
    ledger.entries("c").map(([key]) => key),
    ["manual:-9:opened", "manual:0:opened"],
  );
  ledger.close();
});
