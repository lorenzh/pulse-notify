import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, WRITE_BATCH_MS } from "../src/ledger.ts";
import type { Notification, Schedule } from "../src/types.ts";
import { recordingFs } from "./support.ts";

const dir = mkdtempSync(join(tmpdir(), "notify-ledger2-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

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

/** A schedule whose timers fire only when the test says so. */
function fakeSchedule(): { schedule: Schedule; fire: () => void; delays: number[] } {
  const timers = new Map<number, () => void>();
  const delays: number[] = [];
  let next = 0;
  return {
    delays,
    schedule: (fn, ms) => {
      const id = next++;
      delays.push(ms);
      timers.set(id, fn);
      return () => timers.delete(id);
    },
    fire: () => {
      for (const [id, fn] of [...timers]) {
        timers.delete(id);
        fn();
      }
    },
  };
}

function read(file: string): {
  version: number;
  channels: Record<string, Record<string, { status: string; at: number }>>;
  payloads?: Record<string, Record<string, unknown>>;
  remindersFrom?: Record<string, number>;
} {
  return JSON.parse(readFileSync(file, "utf8"));
}

test("a v1 file loads, entries get the load time, and writes are v2", () => {
  const file = path();
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      channels: { c: { "1:opened": "delivered", "2:opened": "failed" } },
    }),
  );
  const ledger = new Ledger(file, { now: () => 5000 });
  assert.equal(ledger.status("c", "1:opened"), "delivered");
  assert.deepEqual(ledger.failed(), [{ channelId: "c", key: "2:opened", at: 5000 }]);
  ledger.seed("c", ["3:opened"]);
  const saved = read(file);
  assert.equal(saved.version, 2);
  assert.deepEqual(saved.channels.c?.["1:opened"], { status: "delivered", at: 5000 });
  assert.equal(saved.remindersFrom, undefined);
});

test("a newer format or a bad entry is refused", () => {
  const file = path();
  writeFileSync(file, JSON.stringify({ version: 3, channels: {} }));
  assert.throws(() => new Ledger(file), /unsupported format/);
  writeFileSync(file, JSON.stringify({ version: 2, channels: { c: { k: "delivered" } } }));
  assert.throws(() => new Ledger(file), /unsupported format/);
  writeFileSync(file, JSON.stringify({ version: 2, channels: { c: "x" } }));
  assert.throws(() => new Ledger(file), /unsupported format/);
});

test("claim is on disk before it returns, with a time", () => {
  const file = path();
  const ledger = new Ledger(file, { now: () => 1234 });
  ledger.claim("c", "1:opened", note("1:opened"));
  // Crash simulation: read the file without any flush.
  const saved = read(file);
  assert.deepEqual(saved.channels.c?.["1:opened"], { status: "pending", at: 1234 });
  assert.ok(saved.payloads?.c?.["1:opened"]);
});

test("settle is batched: one write after the window, or at flush", async () => {
  const file = path();
  const timers = fakeSchedule();
  const ledger = new Ledger(file, { schedule: timers.schedule });
  ledger.claim("c", "1:opened", note("1:opened"));
  ledger.claim("c", "2:opened", note("2:opened"));
  ledger.settle("c", "1:opened", "delivered");
  ledger.settle("c", "2:opened", "failed");
  assert.deepEqual(timers.delays, [WRITE_BATCH_MS]);
  assert.equal(read(file).channels.c?.["1:opened"]?.status, "pending");
  await ledger.flush();
  const saved = read(file);
  assert.equal(saved.channels.c?.["1:opened"]?.status, "delivered");
  assert.equal(saved.channels.c?.["2:opened"]?.status, "failed");
  // A delivered key loses its payload; a failed key keeps it for a resend.
  assert.equal(saved.payloads?.c?.["1:opened"], undefined);
  assert.ok(saved.payloads?.c?.["2:opened"]);
});

test("the batch timer writes the file", async () => {
  const file = path();
  const timers = fakeSchedule();
  const ledger = new Ledger(file, { schedule: timers.schedule });
  ledger.claim("c", "1:opened", note("1:opened"));
  ledger.settle("c", "1:opened", "delivered");
  timers.fire();
  await ledger.flush();
  assert.equal(read(file).channels.c?.["1:opened"]?.status, "delivered");
});

test("a sync claim between a batch snapshot and its rename is not overwritten", async () => {
  const file = path();
  const timers = fakeSchedule();
  const ledger = new Ledger(file, { schedule: timers.schedule });
  ledger.claim("c", "1:opened", note("1:opened"));
  ledger.settle("c", "1:opened", "delivered");
  const flushing = ledger.flush(); // snapshot taken, write in flight
  ledger.claim("c", "2:opened", note("2:opened")); // sync write of the newer state
  await flushing;
  const saved = read(file);
  assert.equal(saved.channels.c?.["2:opened"]?.status, "pending");
  assert.equal(saved.channels.c?.["1:opened"]?.status, "delivered");
  assert.equal(existsSync(`${file}.batch.tmp`), false);
});

test("a failed batch write reports the error and stays queued", async () => {
  const own = join(dir, "gone");
  const file = join(own, "state.json");
  const errors: Error[] = [];
  const timers = fakeSchedule();
  const ledger = new Ledger(file, { schedule: timers.schedule, onError: (e) => errors.push(e) });
  ledger.claim("c", "1:opened", note("1:opened"));
  ledger.settle("c", "1:opened", "delivered");
  rmSync(own, { recursive: true, force: true });
  timers.fire();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(errors.length, 1);
  await assert.rejects(ledger.flush());
});

test("prune removes old settled entries and payloads, never pending", () => {
  const file = path();
  let clock = 1_000;
  const ledger = new Ledger(file, { now: () => clock, schedule: fakeSchedule().schedule });
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
});

test("prune keeps every incident key until a poll has shown the visible incidents", () => {
  let clock = 0;
  const ledger = new Ledger(path(), { now: () => clock, schedule: fakeSchedule().schedule });
  ledger.seed("c", ["1:opened", "x"]);
  clock = 100_000;
  assert.equal(ledger.prune(1, undefined), 1);
  assert.equal(ledger.has("c", "1:opened"), true);
});

test("prune and the reminder mark are written by flush", async () => {
  const file = path();
  let clock = 0;
  const ledger = new Ledger(file, { now: () => clock, schedule: fakeSchedule().schedule });
  ledger.seed("c", ["x"], 50);
  assert.equal(ledger.remindersFrom("c"), 50);
  assert.equal(read(file).remindersFrom?.c, 50);
  clock = 100;
  ledger.prune(10, new Set());
  ledger.setRemindersFrom("c", undefined);
  await ledger.flush();
  const saved = read(file);
  assert.deepEqual(saved.channels.c, {});
  assert.equal(saved.remindersFrom?.c, undefined);
  assert.equal(new Ledger(file).remindersFrom("c"), undefined);
});

test("resend sets a failed key back to pending and keeps its payload", () => {
  const file = path();
  const ledger = new Ledger(file, { schedule: fakeSchedule().schedule });
  ledger.claim("c", "1:opened", note("1:opened"));
  ledger.settle("c", "1:opened", "failed");
  assert.equal(ledger.resend("c", "9:opened"), "not-failed");
  assert.equal(ledger.resend("c", "1:opened"), "resent");
  assert.equal(read(file).channels.c?.["1:opened"]?.status, "pending");
  assert.deepEqual(new Ledger(file).pending(), [
    { channelId: "c", key: "1:opened", notification: note("1:opened") },
  ]);
  assert.equal(ledger.resend("c", "1:opened"), "not-failed");
});

test("resend of a failed key without a payload is refused", () => {
  const file = path();
  writeFileSync(file, JSON.stringify({ version: 1, channels: { c: { "1:opened": "failed" } } }));
  const ledger = new Ledger(file);
  assert.equal(ledger.resend("c", "1:opened"), "no-payload");
  assert.equal(ledger.status("c", "1:opened"), "failed");
});

test("a failed seed or claim rolls back its change, including pruned reminders", async () => {
  const file = path();
  const fs = recordingFs();
  const ledger = new Ledger(file, { schedule: fakeSchedule().schedule, fs });
  const reminder = (n: number): Notification => ({
    ...note(`1:reminder:${n}`),
    event: "reminder",
  });
  ledger.claim("c", "1:reminder:1", reminder(1));
  ledger.settle("c", "1:reminder:1", "delivered");
  await ledger.flush();
  fs.faults.isOpenTempFailing = true;
  assert.throws(() => ledger.claim("c", "1:reminder:2", reminder(2)));
  assert.equal(ledger.status("c", "1:reminder:1"), "delivered");
  assert.equal(ledger.has("c", "1:reminder:2"), false);
  assert.throws(() => ledger.seed("c", ["z"], 7));
  assert.equal(ledger.has("c", "z"), false);
  assert.equal(ledger.remindersFrom("c"), undefined);
  fs.faults.isOpenTempFailing = false;
  ledger.claim("c", "1:reminder:2", reminder(2));
  assert.equal(new Ledger(file).status("c", "1:reminder:2"), "pending");
});

test("close stops batched writes", async () => {
  const file = path();
  const ledger = new Ledger(file, { schedule: fakeSchedule().schedule });
  ledger.claim("c", "1:opened", note("1:opened"));
  ledger.settle("c", "1:opened", "delivered");
  ledger.close();
  await ledger.flush();
  assert.equal(read(file).channels.c?.["1:opened"]?.status, "pending");
});
