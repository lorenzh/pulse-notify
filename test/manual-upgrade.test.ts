import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManualIncident } from "@lorenzh/pulse-contract";
import { runFailed } from "../src/failed-cli.ts";
import { Ledger } from "../src/ledger.ts";
import { Notifier } from "../src/notifier.ts";
import type { Notification } from "../src/types.ts";
import {
  asRecord,
  type FakeApi,
  incident,
  manualIncident,
  type RecordingFs,
  recordingFs,
  type SpyLogger,
  spyLogger,
  startFakeApi,
} from "./support.ts";

// Keys computed outside notify: printf '%s' '[2000,"identified","A"]' | sha256sum | cut -c1-32
const KEY_A = "manual:7:update:f678dad88b133092b817969667345bdd";
const KEY_X = "manual:7:update:944060dad462720cba7f4ef5321c14ae";

const V2_LEDGER = { version: 2, channels: { web: { "1:opened": { status: "delivered", at: 1 } } } };
const V1_LEDGER = { version: 1, channels: { web: { "1:opened": "delivered" } } };

const creation = { at: 500, status: "investigating", message: "c" } as const;
const updateA = { at: 2000, status: "identified", message: "A" } as const;
const updateB = { at: 3000, status: "monitoring", message: "B" } as const;
const updateX = { at: 1000, status: "investigating", message: "X" } as const;

const open7 = (updates: ManualIncident["updates"]): ManualIncident =>
  manualIncident({
    id: 7,
    createdAt: 500,
    status: updates.at(-1)?.status ?? "investigating",
    updates,
  });
const resolved8 = manualIncident({
  id: 8,
  createdAt: 500,
  status: "resolved",
  resolvedAt: 600,
  updates: [
    { at: 500, status: "investigating", message: "d" },
    { at: 600, status: "resolved", message: "done" },
  ],
});

let api: FakeApi;
let dir: string;
let logger: SpyLogger;
let clock: number;

beforeEach(async () => {
  api = await startFakeApi();
  dir = mkdtempSync(join(tmpdir(), "notify-upgrade-"));
  logger = spyLogger();
  clock = 10_000;
});
afterEach(async () => {
  await api.close();
  rmSync(dir, { recursive: true, force: true });
});

const statePath = (): string => join(dir, "state.json");
const outPath = (): string => join(dir, "web.jsonl");

function writeState(data: unknown): void {
  writeFileSync(statePath(), JSON.stringify(data));
}

function make(fs?: RecordingFs): Notifier {
  return new Notifier({
    config: { channels: [{ id: "web", type: "file", path: outPath() }] },
    apiUrl: api.url,
    ledger: new Ledger(statePath(), { now: () => clock, ...(fs ? { fs } : {}) }),
    logger,
    now: () => clock,
    sleep: async () => {},
    schedule: () => () => {},
  });
}

async function poll(n: Notifier): Promise<void> {
  await n.tick();
  await n.idle();
}

function sent(): string[] {
  try {
    return readFileSync(outPath(), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => String(asRecord(JSON.parse(l)).key));
  } catch {
    // No file means nothing was delivered.
    return [];
  }
}

function stateFile(): Record<string, unknown> {
  return asRecord(JSON.parse(readFileSync(statePath(), "utf8")));
}

function manualFrom(): unknown {
  const marks = stateFile().manualFrom;
  return marks === undefined ? undefined : asRecord(marks).web;
}

function entry(key: string): unknown {
  return asRecord(asRecord(stateFile().channels).web)[key];
}

for (const [name, data] of [
  ["v2", V2_LEDGER],
  ["v1", V1_LEDGER],
] as const) {
  test(`a known channel of a ${name} ledger seeds the manual feed on first sight and sends none`, async () => {
    writeState(data);
    api.manualIncidents = [open7([creation, updateA]), resolved8];
    const n = make();
    await poll(n);
    assert.deepEqual(sent(), []);
    assert.equal(typeof manualFrom(), "number");
    assert.equal(asRecord(entry(KEY_A)).status, "seeded");
    const line = logger.entries.find(
      (e) => e.msg === "manual incidents initialized: existing manual incidents skipped",
    );
    assert.deepEqual(line?.fields, { channel: "web", incidents: 2 });
    await n.stop();

    const restarted = make();
    await poll(restarted);
    await restarted.stop();
    assert.deepEqual(sent(), []);
  });
}

test("404 and a failed read do not mark; the first good read does, then new incidents are sent", async () => {
  writeState(V2_LEDGER);
  const n = make();
  api.manualIncidents = undefined;
  await poll(n);
  assert.equal(manualFrom(), undefined);
  api.manualIncidents = [];
  api.failingManual = true;
  await poll(n);
  assert.equal(manualFrom(), undefined);
  api.failingManual = false;
  await poll(n);
  assert.equal(typeof manualFrom(), "number");
  api.manualIncidents = [manualIncident({ id: 9 })];
  await poll(n);
  await n.stop();
  assert.deepEqual(sent(), ["manual:9:opened"]);
});

test("a 404 then an existing incident sends nothing", async () => {
  writeState(V2_LEDGER);
  const n = make();
  api.manualIncidents = undefined;
  await poll(n);
  api.manualIncidents = [open7([creation, updateA])];
  await poll(n);
  await n.stop();
  assert.deepEqual(sent(), []);
});

test("a failed seed write marks nothing and sends nothing; the next poll seeds", async () => {
  writeState(V2_LEDGER);
  api.manualIncidents = [open7([creation, updateA])];
  const fs = recordingFs();
  const n = make(fs);
  fs.faults.isOpenTempFailing = true;
  await poll(n);
  assert.ok(logger.entries.some((e) => e.msg === "ledger seed failed, the next poll retries"));
  assert.equal(manualFrom(), undefined);
  fs.faults.isOpenTempFailing = false;
  await poll(n);
  await n.stop();
  assert.equal(typeof manualFrom(), "number");
  assert.deepEqual(sent(), []);
});

test("positional keys already delivered: seeding sends nothing, a later insertion only X", async () => {
  writeState({
    version: 2,
    channels: {
      web: {
        "manual:7:opened": { status: "delivered", at: 1 },
        "manual:7:update:1": { status: "delivered", at: 1 },
      },
    },
  });
  const n = make();
  api.manualIncidents = [open7([creation, updateA, updateB])];
  await poll(n);
  assert.deepEqual(sent(), []);
  api.manualIncidents = [open7([creation, updateX, updateA, updateB])];
  await poll(n);
  await n.stop();
  assert.deepEqual(sent(), [KEY_X]);
});

function legacyUpdate(): Notification {
  return {
    key: "manual:7:update:1",
    event: "update",
    incidentId: 7,
    checkId: "",
    checkName: "Search is slow",
    reason: null,
    time: new Date(2000).toISOString(),
    timeMs: 2000,
    openedMs: 500,
    manual: { impact: "minor", status: "identified", message: "A", componentIds: ["web"] },
  };
}

test("a legacy pending positional key is resent once; a failed one is listed as update", async () => {
  writeState({
    version: 2,
    channels: {
      web: {
        "manual:7:opened": { status: "delivered", at: 1 },
        "manual:7:update:1": { status: "pending", at: 1 },
        "manual:8:update:2": { status: "failed", at: 1 },
      },
    },
    payloads: { web: { "manual:7:update:1": legacyUpdate() } },
  });
  api.manualIncidents = [open7([creation, updateA])];
  const n = make();
  n.start();
  await poll(n);
  await poll(n);
  await n.stop();
  assert.deepEqual(sent(), ["manual:7:update:1"]);
  const listed = runFailed(["list"], new Ledger(statePath())).lines.join("\n");
  assert.match(listed, /manual:8:update:2\t[^\t]+\tupdate\tno payload/);
});

test("seeding leaves reminder state and automatic deliveries alone", async () => {
  writeState(V2_LEDGER);
  api.incidents = [incident({ id: 5 })];
  api.manualIncidents = [open7([creation, updateA])];
  const n = make();
  await poll(n);
  await n.stop();
  assert.deepEqual(sent(), ["5:opened"]);
  assert.equal(stateFile().remindersFrom, undefined);
});

test("an inserted update sends only itself; equal-time updates are told apart", async () => {
  writeState({ ...V2_LEDGER, manualFrom: { web: 1 } });
  api.manualIncidents = [open7([creation, updateA, updateB])];
  const n = make();
  await poll(n);
  const before = sent().length;
  api.manualIncidents = [open7([creation, updateX, updateA, updateB])];
  await poll(n);
  assert.deepEqual(sent().slice(before), [KEY_X]);

  const p = { at: 3500, status: "identified", message: "p" } as const;
  const q = { at: 3500, status: "identified", message: "q" } as const;
  api.manualIncidents = [open7([creation, updateX, updateA, updateB, p, q])];
  await poll(n);
  assert.equal(sent().length, before + 3);
  api.manualIncidents = [open7([creation, updateX, updateA, updateB, q, p])];
  await poll(n);
  await n.stop();
  assert.equal(sent().length, before + 3);
});
