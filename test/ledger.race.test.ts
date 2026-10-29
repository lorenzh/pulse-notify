import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Ledger } from "../src/ledger.ts";
import type { Notification } from "../src/types.ts";

const dir = mkdtempSync(join(tmpdir(), "notify-ledger-race-"));
after(() => {
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

test("a claim during a paused batch write is not erased by the batch rename", async () => {
  const file = path();
  let release: () => void = () => {};
  let paused: () => void = () => {};
  const isPaused = new Promise<void>((resolve) => {
    paused = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ledger = new Ledger(file, {
    schedule: () => () => {},
    hooks: {
      beforeRename: async () => {
        paused();
        await gate;
      },
    },
  });
  ledger.claim("ch", "1:opened", note("1:opened"));
  ledger.settle("ch", "1:opened", "delivered");
  const flushed = ledger.flush();
  await isPaused;
  ledger.claim("ch", "2:opened", note("2:opened"));
  release();
  await flushed;
  for (const ledgerOnDisk of [new Ledger(file)]) {
    assert.equal(ledgerOnDisk.status("ch", "2:opened"), "pending");
    assert.equal(ledgerOnDisk.status("ch", "1:opened"), "delivered");
  }
  const raw = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(raw.channels.ch["2:opened"].status, "pending");
});

test("a failed batch write keeps the ledger dirty so a later flush persists", async () => {
  const file = path();
  let isFailing = true;
  const ledger = new Ledger(file, {
    schedule: () => () => {},
    hooks: {
      beforeRename: async () => {
        if (isFailing) throw new Error("disk gone");
      },
    },
  });
  ledger.claim("ch", "k", note("k"));
  ledger.settle("ch", "k", "delivered");
  await assert.rejects(ledger.flush(), /disk gone/);
  isFailing = false;
  await ledger.flush();
  assert.equal(new Ledger(file).status("ch", "k"), "delivered");
});
