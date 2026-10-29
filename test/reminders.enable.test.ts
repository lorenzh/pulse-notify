import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Ledger } from "../src/ledger.ts";
import { Notifier } from "../src/notifier.ts";
import {
  asRecord,
  type FakeApi,
  httpCheck,
  incident,
  type Receiver,
  spyLogger,
  startFakeApi,
  startReceiver,
} from "./support.ts";

const OPENED = Date.UTC(2026, 0, 1, 12, 0, 0);
const MINUTE = 60_000;

let api: FakeApi;
let rx: Receiver;
let dir: string;
let clock: number;
let ledger: Ledger;

beforeEach(async () => {
  api = await startFakeApi();
  rx = await startReceiver();
  dir = mkdtempSync(join(tmpdir(), "notify-rem-en-"));
  clock = OPENED;
  ledger = new Ledger(join(dir, "state.json"), { now: () => clock });
  api.checks = [httpCheck("example", "Example site")];
});

afterEach(async () => {
  await api.close();
  await rx.close();
  rmSync(dir, { recursive: true, force: true });
});

function make(remindEverySeconds: number | undefined): Notifier {
  return new Notifier({
    config: {
      channels: [
        {
          id: "hook",
          type: "webhook",
          url: rx.url,
          ...(remindEverySeconds === undefined ? {} : { remindEverySeconds }),
        },
      ],
    },
    apiUrl: api.url,
    ledger,
    logger: spyLogger(),
    retryDelayMs: 1,
    sleep: async () => {},
    schedule: () => () => {},
    now: () => clock,
  });
}

const keys = (): string[] => rx.accepted().map((r) => String(asRecord(r.body).key));

async function poll(n: Notifier): Promise<void> {
  await n.tick();
  await n.idle();
}

test("enabling reminders with old open incidents sends nothing, later ones remind normally", async () => {
  const off = make(undefined);
  await poll(off); // seeds the channel without reminders
  api.incidents = [incident({ id: 1, openedAt: OPENED })];
  await poll(off);
  assert.deepEqual(keys(), ["1:opened"]);
  assert.equal(ledger.remindersFrom("hook"), undefined);

  clock = OPENED + 35 * MINUTE;
  const on = make(10 * 60);
  await poll(on);
  assert.deepEqual(keys(), ["1:opened"], "no burst on the first poll with reminders");
  assert.equal(ledger.remindersFrom("hook"), clock);

  // A new incident and a later interval remind as usual.
  api.incidents = [incident({ id: 1, openedAt: OPENED }), incident({ id: 2, openedAt: clock })];
  await poll(on);
  clock = OPENED + 40 * MINUTE;
  await poll(on);
  assert.deepEqual(keys(), ["1:opened", "2:opened", "1:reminder:4"]);
  clock = OPENED + 45 * MINUTE;
  await poll(on);
  assert.deepEqual(keys().slice(3), ["2:reminder:1"]);
});

test("disabling drops the mark, enabling again seeds again", async () => {
  api.incidents = [incident({ id: 1, openedAt: OPENED })];
  const on = make(600);
  await poll(on); // new channel: seeded with the reminder mark
  assert.equal(ledger.remindersFrom("hook"), OPENED);
  const off = make(undefined);
  await poll(off);
  assert.equal(ledger.remindersFrom("hook"), undefined);

  clock = OPENED + 55 * MINUTE;
  const again = make(600);
  await poll(again);
  assert.deepEqual(keys(), [], "re-enabling does not burst");
  assert.equal(ledger.remindersFrom("hook"), clock);
  clock = OPENED + 60 * MINUTE;
  await poll(again);
  assert.deepEqual(keys(), ["1:reminder:6"]);
});

test("a new channel with reminders is seeded and marked in one go", async () => {
  api.incidents = [incident({ id: 1, openedAt: OPENED })];
  clock = OPENED + 25 * MINUTE;
  const on = make(600);
  await poll(on);
  assert.deepEqual(keys(), []);
  assert.equal(ledger.remindersFrom("hook"), clock);
  assert.equal(ledger.status("hook", "1:reminder:2"), "seeded");
});
