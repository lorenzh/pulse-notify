import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Ledger } from "../src/ledger.ts";
import { Notifier } from "../src/notifier.ts";
import { type FakeApi, httpCheck, incident, spyLogger, startFakeApi } from "./support.ts";

const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 0, 1);

let api: FakeApi;
let dir: string;
let clock: number;
let ledger: Ledger;

beforeEach(async () => {
  api = await startFakeApi();
  api.checks = [httpCheck("example", "Example site")];
  dir = mkdtempSync(join(tmpdir(), "notify-prune-"));
  clock = START;
  ledger = new Ledger(join(dir, "state.json"), { now: () => clock });
});

afterEach(async () => {
  await api.close();
  rmSync(dir, { recursive: true, force: true });
});

function make(retentionDays?: number): Notifier {
  return new Notifier({
    config: { channels: [{ id: "log", type: "file", path: join(dir, "out.jsonl") }] },
    apiUrl: api.url,
    ledger,
    logger: spyLogger(),
    stateRetentionDays: retentionDays,
    schedule: () => () => {},
    now: () => clock,
  });
}

const MINUTE = 60_000;

test("settled entries of incidents gone from the API are pruned once they are old enough", async () => {
  ledger.seed("log", ["1:opened", "1:resolved", "2:opened"]);
  const n = make(30);
  api.incidents = [incident({ id: 2, resolvedAt: START + 1 })];
  clock = START + 31 * DAY;
  await n.tick();
  await n.idle();
  // Incident 2 is still listed: its keys stay. Incident 1 is gone from the API: pruned.
  assert.equal(ledger.has("log", "1:opened"), false);
  assert.equal(ledger.has("log", "1:resolved"), false);
  assert.equal(ledger.has("log", "2:opened"), true);
});

test("the prune runs at the first poll, then at most once per hour", async () => {
  ledger.seed("log", ["5:opened"]);
  const n = make(30);
  clock = START + 30 * DAY - 30 * MINUTE;
  await n.tick();
  assert.equal(ledger.has("log", "5:opened"), true, "not old enough yet");
  clock = START + 30 * DAY + 10 * MINUTE;
  await n.tick();
  assert.equal(ledger.has("log", "5:opened"), true, "the hour has not passed");
  clock = START + 30 * DAY + 2 * 60 * MINUTE;
  await n.tick();
  assert.equal(ledger.has("log", "5:opened"), false);
});

test("pending entries are never pruned", async () => {
  ledger.claim("log", "7:opened", {
    key: "7:opened",
    event: "opened",
    incidentId: 7,
    checkId: "example",
    checkName: "Example site",
    reason: null,
    time: "",
    timeMs: 0,
    openedMs: 0,
  });
  const n = make(1);
  clock = START + 100 * DAY;
  await n.tick();
  assert.equal(ledger.status("log", "7:opened"), "pending");
});
