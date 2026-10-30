import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { runFailed } from "../src/failed-cli.ts";
import { main, runCli } from "../src/index.ts";
import { Ledger } from "../src/ledger.ts";
import type { Notification } from "../src/types.ts";
import {
  asRecord,
  type FakeApi,
  httpCheck,
  incident,
  type Receiver,
  startFakeApi,
  startReceiver,
} from "./support.ts";

const dir = mkdtempSync(join(tmpdir(), "notify-failed-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let api: FakeApi;
let rx: Receiver;
let state: string;
let counter = 0;

beforeEach(async () => {
  api = await startFakeApi();
  rx = await startReceiver();
  api.checks = [httpCheck("example", "Example site")];
  state = join(dir, `state-${counter++}.json`);
});

afterEach(async () => {
  await api.close();
  await rx.close();
});

function note(key: string, event: Notification["event"] = "opened"): Notification {
  return {
    key,
    event,
    incidentId: Number(key.split(":")[0]),
    checkId: "example",
    checkName: "Example site",
    reason: null,
    time: "2026-01-01T00:00:00.000Z",
    timeMs: 0,
    openedMs: 0,
  };
}

async function failedLedger(): Promise<Ledger> {
  const ledger = new Ledger(state, { now: () => Date.UTC(2026, 0, 2) });
  ledger.claim("hook", "1:opened", note("1:opened"));
  ledger.claim("hook", "2:opened", note("2:opened"));
  ledger.claim("chat", "1:opened", note("1:opened"));
  for (const [channel, key] of [
    ["hook", "1:opened"],
    ["hook", "2:opened"],
    ["chat", "1:opened"],
  ] as const) {
    ledger.settle(channel, key, "failed");
  }
  await ledger.flush();
  return ledger;
}

test("failed list prints one line per entry; no entries is exit 0", async () => {
  const empty = new Ledger(state);
  assert.deepEqual(runFailed(["list"], empty), { lines: ["no failed notifications"], code: 0 });
  const ledger = await failedLedger();
  const result = runFailed(["list"], ledger);
  assert.equal(result.code, 0);
  assert.equal(result.lines.length, 3);
  assert.ok(
    result.lines.includes("hook\t1:opened\t2026-01-02T00:00:00.000Z\topened\tpayload"),
    result.lines.join("\n"),
  );
});

test("failed list marks an entry without payload", () => {
  writeFileSync(state, JSON.stringify({ version: 1, channels: { c: { "5:resolved": "failed" } } }));
  const lines = runFailed(["list"], new Ledger(state)).lines;
  assert.match(lines[0] ?? "", /^c\t5:resolved\t.*\tresolved\tno payload$/);
});

test("resend <key> sets the entry pending in every channel, --channel narrows it", async () => {
  const ledger = await failedLedger();
  const narrowed = runFailed(["resend", "1:opened", "--channel", "chat"], ledger);
  assert.equal(narrowed.code, 0);
  assert.equal(ledger.status("chat", "1:opened"), "pending");
  assert.equal(ledger.status("hook", "1:opened"), "failed");
  const rest = runFailed(["resend", "1:opened"], ledger);
  assert.equal(rest.code, 0);
  assert.equal(ledger.status("hook", "1:opened"), "pending");
  assert.equal(ledger.status("hook", "2:opened"), "failed");
});

test("resend --all, with and without --channel", async () => {
  const ledger = await failedLedger();
  assert.equal(runFailed(["resend", "--all", "--channel", "hook"], ledger).code, 0);
  assert.equal(ledger.status("hook", "2:opened"), "pending");
  assert.equal(ledger.status("chat", "1:opened"), "failed");
  assert.equal(runFailed(["resend", "--all"], ledger).code, 0);
  assert.equal(ledger.failed().length, 0);
  assert.deepEqual(runFailed(["resend", "--all"], ledger), {
    lines: ["no failed notifications to resend"],
    code: 0,
  });
});

test("an unknown key is exit 1", async () => {
  const ledger = await failedLedger();
  assert.equal(runFailed(["resend", "99:opened"], ledger).code, 1);
  assert.equal(runFailed(["resend", "1:opened", "--channel", "nope"], ledger).code, 1);
});

test("an entry without a payload is refused; --all skips it and exits 1", () => {
  writeFileSync(
    state,
    JSON.stringify({ version: 1, channels: { c: { "5:opened": "failed", "6:opened": "failed" } } }),
  );
  const ledger = new Ledger(state);
  const one = runFailed(["resend", "5:opened"], ledger);
  assert.equal(one.code, 1);
  assert.match(one.lines.join("\n"), /no payload/);
  assert.equal(ledger.status("c", "5:opened"), "failed");
  const all = runFailed(["resend", "--all"], ledger);
  assert.equal(all.code, 1);
  assert.equal(all.lines.filter((l) => l.startsWith("skipped")).length, 2);
});

test("bad arguments print the usage and exit 1", async () => {
  const ledger = await failedLedger();
  for (const args of [
    [],
    ["nope"],
    ["list", "extra"],
    ["resend"],
    ["resend", "--all", "1:opened"],
    ["resend", "a", "b"],
    ["resend", "--channel"],
    ["resend", "--all", "--bogus"],
  ]) {
    const result = runFailed(args, ledger);
    assert.equal(result.code, 1, args.join(" "));
    assert.match(result.lines[0] ?? "", /usage/);
  }
});

/** The CLI runs in the test process, so give it its own pid: the same pid would look stale. */
function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  return runCli(
    args,
    { PULSE_NOTIFY_STATE: state },
    {
      lock: { pid: process.pid + 1 },
      write: (l) => {
        out += l;
      },
      writeError: (l) => {
        err += l;
      },
    },
  ).then((code) => ({ code, out, err }));
}

test("the CLI lists and resends under the state lock, and frees it", async () => {
  await failedLedger();
  const listed = await cli(["list"]);
  assert.equal(listed.code, 0);
  assert.equal(listed.out.trim().split("\n").length, 3);
  const resent = await cli(["resend", "--all"]);
  assert.equal(resent.code, 0);
  assert.match(resent.out, /resent hook 1:opened/);
  assert.equal(new Ledger(state).pending().length, 3);
  assert.equal((await cli(["list"])).out.trim(), "no failed notifications");
});

test("the CLI exits 2 while the lock is held", async () => {
  await failedLedger();
  writeFileSync(
    `${state}.lock`,
    JSON.stringify({ pid: 1, hostname: "elsewhere", token: "t", heartbeat: Date.now() }),
  );
  const result = await cli(["list"]);
  assert.equal(result.code, 2);
  assert.match(result.err, /in use by elsewhere pid 1/);
  assert.equal(result.out, "");
});

test("end to end: a 404 receiver fails the event, the CLI resends it, the service delivers it once", async () => {
  const configPath = join(dir, `config-${counter}.json`);
  writeFileSync(
    configPath,
    JSON.stringify({ channels: [{ id: "hook", type: "webhook", url: rx.url }] }),
  );
  const env = {
    PULSE_NOTIFY_CONFIG: configPath,
    PULSE_NOTIFY_STATE: state,
    PULSE_API_URL: api.url,
    PULSE_NOTIFY_POLL_MS: "20",
    PULSE_NOTIFY_RETRY_ATTEMPTS: "5",
    PULSE_HEALTH_PORT: "0",
  };
  const start = () => {
    const lines: string[] = [];
    const running = main(env, { write: (l) => lines.push(l) });
    return { running, lines };
  };
  const waitFor = async (check: () => boolean): Promise<void> => {
    for (let i = 0; i < 500 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(check(), "timed out waiting");
  };

  rx.status = 404;
  const first = start();
  await first.running.listening;
  // The service is running: the CLI must refuse.
  assert.equal((await cli(["list"])).code, 2);
  await waitFor(() => first.lines.some((l) => l.includes("seeded")));
  api.incidents = [incident({ id: 1 })];
  await waitFor(() => first.lines.some((l) => l.includes("notification delivery failed")));
  assert.equal(rx.requests.length, 1, "a 404 is not retried");
  assert.ok(first.lines.some((l) => l.includes('"permanent":true')));
  await first.running.stop();

  const listed = await cli(["list"]);
  assert.equal(listed.code, 0);
  assert.match(listed.out, /^hook\t1:opened\t.*\topened\tpayload$/m);
  assert.equal((await cli(["resend", "1:opened"])).code, 0);

  rx.status = 200;
  const second = start();
  await second.running.listening;
  await waitFor(() => second.lines.some((l) => l.includes("notification delivered")));
  await second.running.stop();
  assert.equal(asRecord(rx.accepted()[0]?.body).key, "1:opened");
  assert.equal(rx.accepted()[0]?.headers["idempotency-key"], "1:opened");
  assert.equal(
    JSON.parse(readFileSync(state, "utf8")).channels.hook["1:opened"].status,
    "delivered",
  );
  assert.equal(rx.accepted().length, 1, "delivered once");
});
