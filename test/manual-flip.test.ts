import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.ts";
import { Notifier } from "../src/notifier.ts";
import type { ChannelConfig } from "../src/types.ts";
import {
  asRecord,
  type FakeApi,
  httpCheck,
  manualIncident,
  spyLogger,
  startFakeApi,
} from "./support.ts";

const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 0, 1, 12, 0, 0);
const CHANNELS = ["all", "web"] as const;

let api: FakeApi;
let dir: string;
let clock: number;
let ledger: Ledger;

beforeEach(async () => {
  api = await startFakeApi();
  api.checks = [httpCheck("example", "Example site")];
  dir = mkdtempSync(join(tmpdir(), "notify-flip-"));
  clock = START;
  ledger = openLedger();
});

afterEach(async () => {
  ledger.close();
  await api.close();
  rmSync(dir, { recursive: true, force: true });
});

function openLedger(): Ledger {
  return new Ledger(join(dir, "state.json"), { now: () => clock });
}

const outPath = (id: string) => join(dir, `${id}.jsonl`);

function keysOf(id: string): unknown[] {
  try {
    return readFileSync(outPath(id), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => asRecord(JSON.parse(l)).key);
  } catch {
    // No file means nothing was delivered.
    return [];
  }
}

function make(): Notifier {
  const channels: ChannelConfig[] = [
    { id: "all", type: "file", path: outPath("all") },
    { id: "web", type: "file", path: outPath("web"), components: ["web"] },
  ];
  return new Notifier({
    config: { channels },
    apiUrl: api.url,
    ledger,
    logger: spyLogger(),
    stateRetentionDays: 1,
    sleep: async () => {},
    schedule: () => () => {},
    now: () => clock,
  });
}

function serve(items: unknown[], status?: number): void {
  api.raw.set("/manual-incidents", {
    ...(status === undefined ? {} : { status }),
    headers: { "content-type": "application/json" },
    body: JSON.stringify(items),
  });
}

async function poll(n: Notifier): Promise<void> {
  await n.tick();
  await n.idle();
}

/** Seeds the never-listed control key at START, so a prune past the retention removes it. */
function seedControl(): void {
  for (const ch of CHANNELS) ledger.seed(ch, ["manual:50:opened"]);
}

function assertControlPruned(): void {
  for (const ch of CHANNELS) assert.equal(ledger.has(ch, "manual:50:opened"), false);
}

const internal = (item: object) => ({ ...item, visibility: "internal", publishedAt: START });
const draft = (item: object) => ({ ...item, visibility: "public", publishedAt: null });

for (const id of [9, -9]) {
  test(`an internal flip past the retention keeps manual:${id}:opened and republication sends nothing`, async () => {
    seedControl();
    const n = make();
    serve([]);
    await poll(n);
    const pub = manualIncident({ id });
    serve([pub]);
    await poll(n);
    for (const ch of CHANNELS) assert.deepEqual(keysOf(ch), [`manual:${id}:opened`]);

    serve([internal(pub)]);
    clock = START + 3 * DAY;
    await poll(n);
    for (const ch of CHANNELS) assert.equal(ledger.has(ch, `manual:${id}:opened`), true);
    assertControlPruned();

    serve([pub]);
    await poll(n);
    for (const ch of CHANNELS) assert.deepEqual(keysOf(ch), [`manual:${id}:opened`]);
    await n.stop();
  });
}

const full = manualIncident({
  id: 9,
  status: "resolved",
  resolvedAt: START + 120_000,
  updates: [
    { at: START, status: "investigating", message: "We are looking." },
    { at: START + 60_000, status: "identified", message: "Found it." },
    { at: START + 120_000, status: "resolved", message: "Fixed." },
  ],
});

/** Delivers opened, update and resolved of `full`, then serves it as a draft past the retention. */
async function deliverThenHideAsDraft(n: Notifier): Promise<unknown[]> {
  seedControl();
  serve([]);
  await poll(n);
  serve([full]);
  await poll(n);
  const delivered = keysOf("all");
  assert.equal(delivered.length, 3);
  serve([draft(full)]);
  clock = START + 3 * DAY;
  await poll(n);
  assertControlPruned();
  return delivered;
}

test("a draft flip keeps opened, update and resolved keys; republication adds no line", async () => {
  const n = make();
  const delivered = await deliverThenHideAsDraft(n);
  serve([full]);
  await poll(n);
  for (const ch of CHANNELS) {
    assert.equal(keysOf(ch).length, 3);
    assert.deepEqual(keysOf(ch), delivered);
  }

  // A truly new public update is still sent once.
  const more = {
    ...full,
    updates: [
      ...full.updates.slice(0, 2),
      { at: START + 90_000, status: "monitoring", message: "Watching." },
      ...full.updates.slice(2),
    ],
  };
  serve([more]);
  await poll(n);
  await poll(n);
  for (const ch of CHANNELS) assert.equal(keysOf(ch).length, 4);
  await n.stop();
});

test("an id absent from a successful empty read loses its keys at the next eligible prune", async () => {
  const n = make();
  await deliverThenHideAsDraft(n);
  serve([]);
  clock = START + 5 * DAY;
  await poll(n);
  for (const ch of CHANNELS) assert.deepEqual(ledger.entries(ch), []);
  await n.stop();
});

for (const status of [500, 404]) {
  test(`a manual feed answering ${status} keeps the last listed ids`, async () => {
    const n = make();
    const delivered = await deliverThenHideAsDraft(n);
    serve([], status);
    clock = START + 5 * DAY;
    await poll(n);
    for (const ch of CHANNELS) {
      for (const key of delivered) assert.equal(ledger.has(ch, String(key)), true);
    }
    await n.stop();
  });
}

test("before any good manual read no manual key is pruned", async () => {
  seedControl();
  serve([], 500);
  const n = make();
  clock = START + 3 * DAY;
  await poll(n);
  for (const ch of CHANNELS) assert.equal(ledger.has(ch, "manual:50:opened"), true);
  await n.stop();
});

test("after a restart on the same ledger a republished incident sends nothing", async () => {
  let n = make();
  await deliverThenHideAsDraft(n);
  await n.stop();
  await ledger.flush();
  ledger.close();
  ledger = openLedger();
  n = make();
  serve([full]);
  await poll(n);
  for (const ch of CHANNELS) assert.equal(keysOf(ch).length, 3);
  await n.stop();
});

test("a listed draft is never seeded and is sent once when published", async () => {
  const d = manualIncident({ id: 12 });
  serve([draft(d)]);
  const n = make();
  await poll(n);
  await poll(n);
  for (const ch of CHANNELS) assert.equal(ledger.has(ch, "manual:12:opened"), false);
  serve([d]);
  await poll(n);
  for (const ch of CHANNELS) assert.deepEqual(keysOf(ch), ["manual:12:opened"]);
  await n.stop();
});

test("a malformed listed item with a safe id protects its keys; other ids do not", async () => {
  const pub = manualIncident({ id: 9 });
  seedControl();
  const n = make();
  serve([]);
  await poll(n);
  serve([pub]);
  await poll(n);
  serve([{ ...internal(pub), title: undefined }]);
  clock = START + 3 * DAY;
  await poll(n);
  for (const ch of CHANNELS) assert.equal(ledger.has(ch, "manual:9:opened"), true);
  assertControlPruned();
  await n.stop();
});

for (const [label, id] of [
  ["a string", "9"],
  ["a fractional", 9.5],
  ["an unsafe", 2 ** 53],
  ["a missing", undefined],
] as const) {
  test(`${label} id gives no protection`, async () => {
    for (const ch of CHANNELS)
      ledger.seed(ch, ["manual:9:opened", "manual:9007199254740992:opened"]);
    const n = make();
    serve([{ ...internal(manualIncident({ id: 1 })), id }]);
    clock = START + 3 * DAY;
    await poll(n);
    for (const ch of CHANNELS) {
      assert.equal(ledger.has(ch, "manual:9:opened"), false);
      assert.equal(ledger.has(ch, "manual:9007199254740992:opened"), false);
    }
    await n.stop();
  });
}
