import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, LedgerClosedError } from "../src/ledger.ts";
import type { Notification } from "../src/types.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

function reads(ledger: Ledger): unknown {
  return {
    entries: ledger.entries("c"),
    other: ledger.entries("other"),
    pending: ledger.pending(),
    failed: ledger.failed(),
    remindersFrom: ledger.remindersFrom("c"),
    manualFrom: ledger.manualFrom("c"),
    checkRouting: ledger.checkRouting("c"),
    componentRouting: ledger.componentRouting("c"),
    hasChannel: [ledger.hasChannel("c"), ledger.hasChannel("other"), ledger.hasChannel("absent")],
  };
}

function files(path: string): unknown {
  return [path, `${path}-wal`, `${path}-shm`, `${path}.v1.bak`].map((file) =>
    existsSync(file) ? readFileSync(file).toString("base64") : null,
  );
}

const REMINDER_MARK = 500;
const PROGRESS = { delivered: ["a@example.test"], refused: [] };

test("every mutation after close throws LedgerClosedError and writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "notify-ledger-closed-"));
  dirs.push(dir);
  const path = join(dir, "state.json");
  // A failed entry without payload exists only after a format 1 migration.
  writeFileSync(path, JSON.stringify({ version: 1, channels: { c: { "9:opened": "failed" } } }));
  let clock = 1000;
  let commits = 0;
  const ledger = new Ledger(path, {
    now: () => clock,
    hooks: {
      beforeCommit: () => {
        commits += 1;
      },
    },
  });
  ledger.seed("c", ["1:opened"]);
  ledger.claim("c", "2:opened", note("2:opened"));
  ledger.claim("c", "3:opened", note("3:opened"));
  ledger.settle("c", "3:opened", "failed");
  ledger.claim("c", "4:opened", note("4:opened"));
  ledger.settle("c", "4:opened", "delivered");
  ledger.setRemindersFrom("c", REMINDER_MARK);
  clock = 100_000;
  ledger.close();

  const baseReads = reads(ledger);
  const baseFiles = files(path);
  commits = 0;

  const cases: [string, () => unknown][] = [
    ["seed new key", () => ledger.seed("c", ["new"])],
    ["seed empty other channel", () => ledger.seed("other", [])],
    ["claim new key", () => ledger.claim("c", "5:opened", note("5:opened"))],
    ["claim duplicate pending key", () => ledger.claim("c", "2:opened", note("2:opened"))],
    ["settle pending key", () => ledger.settle("c", "2:opened", "delivered")],
    ["settle absent key", () => ledger.settle("c", "absent", "delivered")],
    ["settle delivered key", () => ledger.settle("c", "4:opened", "failed")],
    ["resend failed key with payload", () => ledger.resend("c", "3:opened")],
    ["resend delivered key", () => ledger.resend("c", "4:opened")],
    ["resend failed key without payload", () => ledger.resend("c", "9:opened")],
    ["setRecipients pending key", () => ledger.setRecipients("c", "2:opened", PROGRESS)],
    ["setRecipients absent key", () => ledger.setRecipients("c", "absent", PROGRESS)],
    ["setRemindersFrom equal mark", () => ledger.setRemindersFrom("c", REMINDER_MARK)],
    ["setRemindersFrom absent undefined", () => ledger.setRemindersFrom("absent", undefined)],
    ["setRemindersFrom other mark", () => ledger.setRemindersFrom("c", 900)],
    ["prune without candidate", () => ledger.prune(1_000_000_000, undefined)],
    ["prune with candidates", () => ledger.prune(1, new Set(), new Set())],
  ];
  assert.equal(cases.length, 17);
  const failures: string[] = [];
  for (const [name, call] of cases) {
    try {
      call();
      failures.push(`${name}: no throw`);
    } catch (err) {
      if (!(err instanceof LedgerClosedError)) failures.push(`${name}: ${String(err)}`);
      else {
        assert.equal(err.name, "LedgerClosedError");
        assert.equal(err.message, "ledger is closed");
      }
    }
  }
  assert.deepEqual(failures, []);
  assert.equal(commits, 0);

  assert.deepEqual(reads(ledger), baseReads);
  assert.deepEqual(files(path), baseFiles);

  const reopened = new Ledger(path, { now: () => clock });
  try {
    assert.deepEqual(reads(reopened), baseReads);
    assert.equal(reopened.status("c", "4:opened"), "delivered");
  } finally {
    reopened.close();
  }
});
