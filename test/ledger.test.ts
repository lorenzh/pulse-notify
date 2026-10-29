import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Ledger } from "../src/ledger.ts";
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

test("settle removes the payload; a ledger without payloads loads", async () => {
  const path = tmpPath();
  const a = new Ledger(path);
  a.claim("c", "1:opened", note("1:opened"));
  a.settle("c", "1:opened", "delivered");
  await a.flush();
  assert.deepEqual(new Ledger(path).pending(), []);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).payloads, { c: {} });

  writeFileSync(path, JSON.stringify({ version: 1, channels: { c: { "9:opened": "pending" } } }));
  assert.deepEqual(new Ledger(path).pending(), [{ channelId: "c", key: "9:opened" }]);
});

test("a failed sync write leaves the state unchanged", () => {
  const path = tmpPath();
  const ledger = new Ledger(path);
  ledger.seed("c", []);
  // A directory at the temp path makes the write fail.
  mkdirSync(`${path}.tmp`);
  assert.throws(() => ledger.claim("c", "1:opened", note("1:opened")));
  assert.equal(ledger.has("c", "1:opened"), false);
  assert.throws(() => ledger.seed("d", []));
  assert.equal(ledger.hasChannel("d"), false);
  rmSync(`${path}.tmp`, { recursive: true });
  assert.equal(ledger.claim("c", "1:opened", note("1:opened")), true);
});
