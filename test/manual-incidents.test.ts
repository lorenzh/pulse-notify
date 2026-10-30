import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isManualRouted } from "../src/channels/routing.ts";
import { detectManualEvents, seedManualKeys } from "../src/detector.ts";
import { Ledger } from "../src/ledger.ts";
import { Notifier } from "../src/notifier.ts";
import type { ChannelConfig } from "../src/types.ts";
import {
  asRecord,
  type FakeApi,
  incident,
  manualIncident,
  type SpyLogger,
  spyLogger,
  startFakeApi,
} from "./support.ts";

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const open = manualIncident({ id: 7 });
const withUpdate = manualIncident({
  id: 7,
  status: "identified",
  updates: [
    { at: T0, status: "investigating", message: "We are looking." },
    { at: T0 + 60_000, status: "identified", message: "Found it <b>x</b>." },
  ],
});
const resolved = manualIncident({
  id: 7,
  status: "resolved",
  resolvedAt: T0 + 120_000,
  updates: [...withUpdate.updates, { at: T0 + 120_000, status: "resolved", message: "Fixed." }],
});

test("detector: keys for opened, update and resolved", () => {
  const keys = detectManualEvents([resolved], () => false).map((e) => [e.key, e.event]);
  assert.deepEqual(keys, [
    ["manual:7:opened", "opened"],
    ["manual:7:update:1", "update"],
    ["manual:7:resolved", "resolved"],
  ]);
});

test("detector: resolving by an update yields one resolved event and no update event", () => {
  const direct = manualIncident({
    id: 8,
    status: "resolved",
    resolvedAt: T0 + 1,
    updates: [
      { at: T0, status: "investigating", message: "a" },
      { at: T0 + 1, status: "resolved", message: "Resolved." },
    ],
  });
  const events = detectManualEvents([direct], () => false).map((e) => e.event);
  assert.deepEqual(events, ["opened", "resolved"]);
});

test("detector: handled keys are skipped and seeding covers all keys", () => {
  assert.deepEqual(seedManualKeys([resolved]), [
    "manual:7:opened",
    "manual:7:update:1",
    "manual:7:resolved",
  ]);
  assert.deepEqual(
    detectManualEvents([resolved], (k) => seedManualKeys([resolved]).includes(k)),
    [],
  );
});

test("routing: component filters apply, check filters are ignored", () => {
  assert.equal(isManualRouted({}, []), true);
  assert.equal(isManualRouted({}, ["web"]), true);
  assert.equal(isManualRouted({ components: ["web"] }, ["web", "db"]), true);
  assert.equal(isManualRouted({ components: ["web"] }, ["db"]), false);
  assert.equal(isManualRouted({ components: ["web"] }, []), false);
  assert.equal(isManualRouted({ excludeComponents: ["db"] }, []), true);
  assert.equal(isManualRouted({ excludeComponents: ["db"] }, ["web", "db"]), false);
  assert.equal(isManualRouted({ components: ["web"], excludeComponents: ["web"] }, ["web"]), false);
  assert.equal(isManualRouted({ checks: ["x"] } as never, ["web"]), true);
});

let api: FakeApi;
let dir: string;
let logger: SpyLogger;

beforeEach(async () => {
  api = await startFakeApi();
  dir = mkdtempSync(join(tmpdir(), "notify-manual-"));
  logger = spyLogger();
});
afterEach(async () => {
  await api.close();
});

const outPath = (id: string) => join(dir, `${id}.jsonl`);

function out(id: string): Record<string, unknown>[] {
  try {
    return readFileSync(outPath(id), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => asRecord(JSON.parse(l)));
  } catch {
    // No file means nothing was delivered.
    return [];
  }
}

const channels: ChannelConfig[] = [
  { id: "all", type: "file", path: "" },
  { id: "web", type: "file", path: "", components: ["web"] },
  { id: "db", type: "file", path: "", components: ["db"] },
  { id: "checks", type: "file", path: "", checks: ["nothing"] },
];

function make(): Notifier {
  return new Notifier({
    config: {
      channels: channels.map((c) => ({ ...c, path: outPath(c.id) }) as ChannelConfig),
    },
    apiUrl: api.url,
    ledger: new Ledger(join(dir, "state.json")),
    logger,
    sleep: async () => {},
    schedule: () => () => {},
  });
}

test("one delivery per key with routing, and a restart sends nothing twice", async () => {
  api.manualIncidents = [];
  let n = make();
  await n.tick();

  api.manualIncidents = [open];
  await n.tick();
  await n.idle();
  api.manualIncidents = [withUpdate];
  await n.tick();
  await n.idle();
  api.manualIncidents = [resolved];
  await n.tick();
  await n.tick();
  await n.idle();

  assert.deepEqual(
    out("all").map((e) => e.key),
    ["manual:7:opened", "manual:7:update:1", "manual:7:resolved"],
  );
  assert.deepEqual(
    out("web").map((e) => e.key),
    out("all").map((e) => e.key),
  );
  assert.deepEqual(out("db"), []);
  assert.equal(out("checks").length, 3);
  const first = out("all")[0];
  assert.deepEqual(first?.manual, {
    impact: "minor",
    status: "investigating",
    message: "We are looking.",
    componentIds: ["web"],
  });
  assert.equal(first?.checkName, "Search is slow");
  assert.equal(out("all")[1]?.timeMs, T0 + 60_000);
  assert.equal(asRecord(out("all")[2]?.manual).message, "Fixed.");

  await n.stop();
  n = make();
  await n.tick();
  await n.idle();
  assert.equal(out("all").length, 3);
});

test("first start seeds existing manual incidents without announcing them", async () => {
  api.manualIncidents = [resolved];
  const n = make();
  await n.tick();
  await n.idle();
  assert.deepEqual(out("all"), []);
  api.manualIncidents = [resolved, manualIncident({ id: 9 })];
  await n.tick();
  await n.idle();
  assert.deepEqual(
    out("all").map((e) => e.key),
    ["manual:9:opened"],
  );
});

test("a 404 from an older api is no error and automatic incidents still work", async () => {
  api.manualIncidents = undefined;
  const n = make();
  await n.tick();
  api.incidents = [incident({ id: 1 })];
  await n.tick();
  await n.idle();
  assert.equal(n.pollHealth().consecutiveFailedPolls, 0);
  assert.deepEqual(
    out("all").map((e) => e.key),
    ["1:opened"],
  );
  assert.equal(logger.entries.filter((e) => e.level === "error").length, 0);
  assert.ok(api.requested.includes("/manual-incidents"));
});

test("a failing manual read fails the poll", async () => {
  api.failingManual = true;
  const n = make();
  await n.tick();
  assert.ok(api.requested.includes("/manual-incidents"));
  assert.equal(n.pollHealth().consecutiveFailedPolls, 1);
});
