import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.ts";
import type { Notification } from "../src/types.ts";

const dir = mkdtempSync(join(tmpdir(), "notify-ledger-race-"));
afterAll(() => {
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
const path = (): string => join(dir, `state-${counter++}.json`);

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

test("a claim while a flush is in flight is kept with the earlier settle", async () => {
  const file = path();
  const ledger = new Ledger(file);
  ledger.claim("ch", "1:opened", note("1:opened"));
  ledger.settle("ch", "1:opened", "delivered");
  const flushed = ledger.flush();
  ledger.claim("ch", "2:opened", note("2:opened"));
  await flushed;
  ledger.close();
  const onDisk = new Ledger(file);
  assert.equal(onDisk.status("ch", "2:opened"), "pending");
  assert.equal(onDisk.status("ch", "1:opened"), "delivered");
  onDisk.close();
});

test("a failed claim between a settle and a flush loses neither, and a retry persists", async () => {
  const file = path();
  let isFailing = false;
  const ledger = new Ledger(file, {
    hooks: {
      beforeCommit: () => {
        if (isFailing) throw new Error("injected commit failure");
      },
    },
  });
  ledger.claim("ch", "1:opened", note("1:opened"));
  ledger.settle("ch", "1:opened", "delivered");
  isFailing = true;
  assert.throws(() => ledger.claim("ch", "2:opened", note("2:opened")), /injected/);
  isFailing = false;
  await ledger.flush();
  assert.equal(ledger.claim("ch", "2:opened", note("2:opened")), true);
  ledger.close();
  const onDisk = new Ledger(file);
  assert.equal(onDisk.status("ch", "2:opened"), "pending");
  assert.equal(onDisk.status("ch", "1:opened"), "delivered");
  onDisk.close();
});

test("a closed ledger after lock loss writes nothing, also during a flush", async () => {
  const file = path();
  const ledger = new Ledger(file);
  ledger.claim("ch", "1:opened", note("1:opened"));
  const flushed = ledger.flush();
  ledger.close();
  await flushed;
  assert.throws(() => ledger.settle("ch", "1:opened", "delivered"), {
    name: "LedgerClosedError",
  });
  const onDisk = new Ledger(file);
  assert.equal(onDisk.status("ch", "1:opened"), "pending");
  onDisk.close();
});
