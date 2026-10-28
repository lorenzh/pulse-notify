import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Ledger } from "../src/ledger.ts";

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), "notify-ledger-")), "sub", "state.json");
}

test("state persists across instances", () => {
  const path = tmpPath();
  const a = new Ledger(path);
  assert.equal(a.hasChannel("c"), false);
  a.seed("c", ["1:opened"]);
  assert.equal(a.claim("c", "2:opened"), true);
  assert.equal(a.claim("c", "3:opened"), true);
  a.settle("c", "3:opened", "delivered");
  assert.equal(a.claim("c", "4:opened"), true);
  a.settle("c", "4:opened", "failed");

  const b = new Ledger(path);
  assert.equal(b.hasChannel("c"), true);
  assert.equal(b.hasChannel("other"), false);
  assert.equal(b.status("c", "1:opened"), "seeded");
  assert.equal(b.status("c", "2:opened"), "pending");
  assert.equal(b.status("c", "3:opened"), "delivered");
  assert.equal(b.status("c", "4:opened"), "failed");
  assert.deepEqual(b.pending(), [{ channelId: "c", key: "2:opened" }]);
});

test("claim refuses a recorded key and settle needs a pending claim", () => {
  const ledger = new Ledger(tmpPath());
  assert.equal(ledger.claim("c", "k"), true);
  assert.equal(ledger.claim("c", "k"), false);
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
  writeFileSync(path, JSON.stringify({ version: 2 }));
  assert.throws(() => new Ledger(path), /unsupported format/);
});
