import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, type LedgerOptions } from "../src/ledger.ts";
import { Notifier } from "../src/notifier.ts";
import type { ChannelConfig, IncidentNotification } from "../src/types.ts";
import {
  asRecord,
  budgetNote,
  type FakeApi,
  httpCheck,
  incident,
  type Receiver,
  type SpyLogger,
  spyLogger,
  startFakeApi,
  startReceiver,
} from "./support.ts";

const byText = (a: string, b: string): number => a.localeCompare(b);
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const DROP_TEXT = "cannot drop pending incident notifications of channels with sendIncidents false";

let api: FakeApi;
let rx: Receiver;
let dir: string;
let logger: SpyLogger;
let ledgers: Ledger[];

beforeEach(async () => {
  api = await startFakeApi();
  rx = await startReceiver();
  dir = mkdtempSync(join(tmpdir(), "notify-send-incidents-"));
  logger = spyLogger();
  ledgers = [];
  api.checks = [httpCheck("example", "Example")];
});

afterEach(async () => {
  for (const ledger of ledgers) ledger.close();
  await api.close();
  await rx.close();
  rmSync(dir, { recursive: true, force: true });
});

function open(opts: LedgerOptions = {}): Ledger {
  const ledger = new Ledger(join(dir, "state.db"), { now: () => T0, ...opts });
  ledgers.push(ledger);
  return ledger;
}

function reopen(opts: LedgerOptions = {}): Ledger {
  ledgers.pop()?.close();
  return open(opts);
}

function channel(sendIncidents: boolean): ChannelConfig {
  return { id: "w", type: "webhook", url: rx.url, alerts: ["budget-low"], sendIncidents };
}

function make(ledger: Ledger, sendIncidents: boolean): Notifier {
  return new Notifier({
    config: { channels: [channel(sendIncidents)] },
    apiUrl: api.url,
    ledger,
    logger,
    now: () => T0,
    retryDelayMs: 1,
    sleep: async () => {},
    schedule: () => () => {},
  });
}

function note(key: string): IncidentNotification {
  return {
    key,
    event: "opened",
    incidentId: Number(key.split(":")[0]),
    checkId: "example",
    checkName: "Example",
    reason: null,
    time: new Date(T0).toISOString(),
    timeMs: T0,
    openedMs: T0,
  };
}

const BUDGET = budgetNote();

/** A channel record with 7:opened and one budget warning pending. */
function seedTwoPending(ledger: Ledger): void {
  ledger.seed("w", []);
  ledger.claim("w", "7:opened", note("7:opened"));
  ledger.claim("w", BUDGET.key, BUDGET);
}

function keys(): unknown[] {
  return rx.accepted().map((r) => asRecord(r.body).key);
}

async function run(n: Notifier, polls: number): Promise<void> {
  n.start();
  for (let i = 0; i < polls; i++) {
    await n.tick();
    await n.idle();
  }
  await n.stop();
}

test("a sendIncidents false start drops stored incidents and sends only the warning", async () => {
  const ledger = open();
  ledger.seed("w", ["9:opened"]);
  for (const key of ["1:opened", "2:resolved", "manual:3:opened", "4:reminder:1"]) {
    ledger.claim("w", key, note(key));
  }
  ledger.claim("w", BUDGET.key, BUDGET);
  ledger.claim("w", "5:opened", note("5:opened"));
  ledger.settle("w", "5:opened", "failed");
  const n = make(ledger, false);
  const dropped = logger.entries.filter(
    (e) => e.msg === "incident notifications dropped: channel sends no incidents",
  );
  assert.deepEqual(
    dropped.map((e) => e.fields),
    [{ channel: "w", count: 4 }],
  );
  assert.equal(ledger.status("w", "5:opened"), "failed");
  api.incidents = [incident({ id: 9, checkId: "example" }), incident({ id: 10 })];
  await run(n, 10);
  assert.deepEqual(keys(), [BUDGET.key]);
  assert.equal(ledger.status("w", "10:opened"), "seeded");

  // failed resend sets 5:opened pending; the next start drops it.
  assert.equal(ledger.resend("w", "5:opened"), "resent");
  const again = reopen();
  const second = make(again, false);
  assert.equal(again.status("w", "5:opened"), "dropped");

  // Re-enabled: no old key is sent, only a new resolution.
  await second.stop();
  const third = make(reopen(), true);
  api.incidents = [
    incident({ id: 9, checkId: "example", resolvedAt: T0 + 1000 }),
    incident({ id: 10 }),
  ];
  await run(third, 3);
  assert.deepEqual(keys(), [BUDGET.key, "9:resolved"]);
});

test("a failed drop fails construction and leaves both entries owed", () => {
  let isFailing = false;
  const ledger = open({
    hooks: {
      beforeCommit: () => {
        if (isFailing) throw new Error("disk full");
      },
    },
  });
  seedTwoPending(ledger);
  isFailing = true;
  assert.throws(() => make(ledger, false), { name: "IncidentDropError", message: DROP_TEXT });
  assert.equal(rx.requests.length, 0);
  assert.deepEqual(
    ledger
      .pending()
      .map((p) => p.key)
      .sort(byText),
    ["7:opened", BUDGET.key].sort(byText),
  );
});

test("after a failed drop a restart with true sends both owed entries once", async () => {
  let isFailing = true;
  const ledger = open({
    hooks: {
      beforeCommit: () => {
        if (isFailing && ledger.pending().length === 2) throw new Error("disk full");
      },
    },
  });
  isFailing = false;
  seedTwoPending(ledger);
  isFailing = true;
  assert.throws(() => make(ledger, false), { message: DROP_TEXT });
  await run(make(reopen(), true), 2);
  assert.deepEqual(keys().map(String).sort(byText), ["7:opened", BUDGET.key].sort(byText));
});

test("after a failed drop a good false start sends only the warning, also after re-enable", async () => {
  let isFailing = false;
  const hooks = {
    beforeCommit: () => {
      if (isFailing) throw new Error("disk full");
    },
  };
  seedTwoPending(open({ hooks }));
  isFailing = true;
  assert.throws(() => make(ledgers[0] as Ledger, false), { message: DROP_TEXT });
  isFailing = false;
  await run(make(reopen(), false), 1);
  assert.deepEqual(keys(), [BUDGET.key]);
  await run(make(reopen(), true), 10);
  assert.deepEqual(keys(), [BUDGET.key]);
});

test("a failed incident seed is logged and the next poll seeds the key", async () => {
  let isFailing = false;
  const ledger = open({
    hooks: {
      beforeCommit: () => {
        if (isFailing) throw new Error("disk full");
      },
    },
  });
  const n = make(ledger, false);
  await n.tick();
  api.incidents = [incident({ id: 9, checkId: "example" })];
  isFailing = true;
  await n.tick();
  assert.ok(logger.entries.some((e) => e.msg === "incident seed failed, the next poll retries"));
  assert.equal(ledger.status("w", "9:opened"), undefined);
  isFailing = false;
  await n.tick();
  await n.idle();
  assert.equal(ledger.status("w", "9:opened"), "seeded");
  assert.equal(rx.requests.length, 0);
  await n.stop();
});
