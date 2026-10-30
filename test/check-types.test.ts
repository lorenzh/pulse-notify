import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.ts";
import { Notifier } from "../src/notifier.ts";
import {
  asRecord,
  dnsCheck,
  domainCheck,
  type FakeApi,
  heartbeatCheck,
  httpCheck,
  incident,
  type SpyLogger,
  spyLogger,
  startFakeApi,
  tcpCheck,
  tlsCheck,
} from "./support.ts";

let api: FakeApi;
let dir: string;
let logger: SpyLogger;

beforeEach(async () => {
  api = await startFakeApi();
  dir = mkdtempSync(join(tmpdir(), "notify-check-types-"));
  logger = spyLogger();
});
afterEach(async () => {
  await api.close();
  rmSync(dir, { recursive: true, force: true });
});

function delivered(): Record<string, unknown>[] {
  try {
    return readFileSync(join(dir, "out.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => asRecord(JSON.parse(l)));
  } catch {
    // No file means nothing was delivered.
    return [];
  }
}

test("every check type of the contract gives its incidents the check name", async () => {
  api.checks = [
    httpCheck("c1", "Website"),
    tlsCheck("c2", "Certificate"),
    heartbeatCheck("c3", "Nightly job"),
    tcpCheck("c4", "DB port"),
    dnsCheck("c5", "DNS record"),
    domainCheck("c6", "Domain expiry"),
  ];
  const n = new Notifier({
    config: { channels: [{ id: "out", type: "file", path: join(dir, "out.jsonl") }] },
    apiUrl: api.url,
    ledger: new Ledger(join(dir, "state.json")),
    logger,
    sleep: async () => {},
    schedule: () => () => {},
  });
  await n.tick(); // seeds the channel with no incidents
  api.incidents = api.checks.map((c, i) => incident({ id: i + 1, checkId: c.id }));
  await n.tick();
  await n.idle();

  const sent = delivered();
  assert.equal(sent.length, 6);
  assert.ok(sent.every((e) => e.event === "opened"));
  assert.deepEqual(
    sent.map((e) => [e.checkId, e.checkName]),
    api.checks.map((c) => [c.id, c.name]),
  );
  assert.equal(
    logger.entries.some((e) => e.msg === "check skipped: malformed data"),
    false,
  );
});
