import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.ts";
import type { Notification } from "../src/types.ts";
import { recordingFs } from "./support.ts";

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

test("a failed rewrite after the batch rename keeps the ledger dirty so a later flush persists", async () => {
  const file = path();
  let release: () => void = () => {};
  let paused: () => void = () => {};
  const isPaused = new Promise<void>((resolve) => {
    paused = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fs = recordingFs();
  const ledger = new Ledger(file, {
    fs,
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
  // The rewrite after the rename fails at its temp file; the rename itself succeeds.
  fs.faults.isOpenTempFailing = true;
  release();
  await assert.rejects(flushed);
  fs.faults.isOpenTempFailing = false;
  await ledger.flush();
  const onDisk = new Ledger(file);
  assert.equal(onDisk.status("ch", "2:opened"), "pending");
  assert.equal(onDisk.status("ch", "1:opened"), "delivered");
});

test("a failed directory fsync of the batch still rewrites a claim that slipped in", async () => {
  const file = path();
  const gate = Promise.withResolvers<void>();
  const pause = Promise.withResolvers<void>();
  const fs = recordingFs();
  const ledger = new Ledger(file, {
    fs,
    schedule: () => () => {},
    hooks: {
      beforeRename: async () => {
        pause.resolve();
        await gate.promise;
      },
    },
  });
  ledger.claim("ch", "1:opened", note("1:opened"));
  ledger.settle("ch", "1:opened", "delivered");
  const flushed = ledger.flush();
  await pause.promise;
  ledger.claim("ch", "2:opened", note("2:opened"));
  // Only the batch fails: the claim above already ran its directory fsync.
  fs.faults.isDirFsyncFailing = true;
  gate.resolve();
  await assert.rejects(flushed, /at sync-dir/);
  const onDisk = new Ledger(file);
  assert.equal(onDisk.status("ch", "2:opened"), "pending");
  assert.equal(onDisk.status("ch", "1:opened"), "delivered");
});
