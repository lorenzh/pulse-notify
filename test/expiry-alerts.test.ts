import { afterAll, afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckWithState } from "@lorenzh/pulse-contract";
import { expiryAlerts } from "../src/expiry-alerts.ts";
import { Ledger } from "../src/ledger.ts";
import type { ExpiryNotification } from "../src/types.ts";
import { type AlertStore, checkState, domainCheck, memoryAlerts, tlsCheck } from "./support.ts";

const dir = mkdtempSync(join(tmpdir(), "notify-expiry-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const open: Ledger[] = [];
afterEach(() => {
  for (const ledger of open.splice(0)) ledger.close();
});

let counter = 0;
function newFile(): string {
  return join(dir, `state-${counter++}.json`);
}

function ledgerAt(file: string, now: () => number = () => 0): Ledger {
  const ledger = new Ledger(file, { now });
  open.push(ledger);
  return ledger;
}

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const BOTH = { tls: true, domain: true };
/** The first 32 hex characters of SHA-256("x"), computed outside the code under test. */
const HASH_X = "2d711642b726b04401627ca9fbac32f5";

function tls(days: number | null, readings: number[], id = "x"): CheckWithState {
  return checkState(tlsCheck(id, `TLS ${id}`), { certDaysLeft: days }, readings);
}

function domain(days: number | null, readings: number[], id = "x"): CheckWithState {
  return checkState(domainCheck(id, `Domain ${id}`), { certDaysLeft: days }, readings);
}

/** Evaluates at `nowMs` and commits the changes, as one poll does. */
function poll(ledger: AlertStore, checks: CheckWithState[], nowMs: number): ExpiryNotification[] {
  const result = expiryAlerts(checks, (k, id) => ledger.alertState(k, id), BOTH, nowMs);
  ledger.applyAlerts(result.changes, []);
  return result.notifications;
}

/** Feeds the readings in order, each fresh and newer, and returns the milestones. */
function sequence(
  ledger: AlertStore,
  days: (number | null)[],
  make = tls,
  start = T0,
): ExpiryNotification[] {
  const events: ExpiryNotification[] = [];
  days.forEach((d, i) => {
    const at = start + i * 60_000;
    events.push(...poll(ledger, [make(d, [at])], at));
  });
  return events;
}

const milestones = (events: ExpiryNotification[]): number[] =>
  events.map((e) => e.expiry.milestone);

test("the expiry sequences give the literal milestones", () => {
  const cases: [string, (number | null)[], number[]][] = [
    ["full run", [15, 14, 14, 13, 4, 3, 3, 2, 0, -1], [14, 3]],
    ["15, 13", [15, 13], [14]],
    ["13, 2", [13, 2], [14, 3]],
    ["first 2", [2], [3]],
    ["first 0", [0], [3]],
    ["first -1", [-1], []],
    ["null in between", [14, null, 13], [14]],
    ["small increase", [14, 13, 14, 12], [14]],
  ];
  for (const [name, days, expected] of cases) {
    const ledger = memoryAlerts();
    assert.deepEqual(milestones(sequence(ledger, days)), expected, name);
  }
});

test("TLS and domain checks both give [14, 3] with their own event", () => {
  const days = [15, 14, 14, 13, 4, 3, 3, 2, 0, -1];
  const tlsEvents = sequence(memoryAlerts(), days, tls);
  const domainEvents = sequence(memoryAlerts(), days, domain);
  assert.deepEqual(
    tlsEvents.map((e) => [e.event, e.expiry.milestone]),
    [
      ["tls-expiry", 14],
      ["tls-expiry", 3],
    ],
  );
  assert.deepEqual(
    domainEvents.map((e) => [e.event, e.expiry.milestone]),
    [
      ["domain-expiry", 14],
      ["domain-expiry", 3],
    ],
  );
});

test("a reading above 14 rearms: a new episode gives [14, 3] with a new episode time", () => {
  const ledger = memoryAlerts();
  const days = [15, 14, 14, 13, 4, 3, 3, 2, 0, -1, 90, 14, 3];
  const events = sequence(ledger, days);
  assert.deepEqual(
    events.map((e) => e.key),
    [
      `expiry:${T0 + 60_000}:14:${HASH_X}`,
      `expiry:${T0 + 60_000}:3:${HASH_X}`,
      `expiry:${T0 + 11 * 60_000}:14:${HASH_X}`,
      `expiry:${T0 + 11 * 60_000}:3:${HASH_X}`,
    ],
  );
});

test("the payload carries the days, the milestone and the observation time", () => {
  const ledger = memoryAlerts();
  const check = checkState(tlsCheck("site-tls", "Site TLS"), { certDaysLeft: 13 }, [T0]);
  assert.deepEqual(poll(ledger, [check], T0 + 5000), [
    {
      key: `expiry:${T0}:14:02fa6ac633dcbd84e3498d855c07e8bd`,
      event: "tls-expiry",
      time: "2026-01-01T12:00:05.000Z",
      timeMs: T0 + 5000,
      subject: { kind: "check", id: "site-tls", name: "Site TLS" },
      expiry: { daysLeft: 13, milestone: 14, observedMs: T0 },
    },
  ]);
});

test("a restart between two readings of 14 sends the milestone once", () => {
  const file = newFile();
  const first = ledgerAt(file);
  assert.deepEqual(milestones(poll(first, [tls(14, [T0])], T0)), [14]);
  first.close();
  const again = ledgerAt(file);
  assert.deepEqual(milestones(poll(again, [tls(14, [T0 + 60_000])], T0 + 60_000)), []);
  assert.deepEqual(milestones(poll(again, [tls(13, [T0 + 120_000])], T0 + 120_000)), []);
});

test("a delivery prune does not touch the alert state", () => {
  const DAY = 86_400_000;
  let clock = T0;
  const ledger = ledgerAt(newFile(), () => clock);
  const result = expiryAlerts([tls(14, [T0])], (k, id) => ledger.alertState(k, id), BOTH, T0);
  ledger.applyAlerts(
    result.changes,
    result.notifications.map((n) => ({ channelId: "w", key: n.key, notification: n })),
  );
  const [entry] = ledger.pending();
  assert.ok(entry);
  ledger.settle("w", entry.key, "delivered");
  clock = T0 + 2 * DAY;
  assert.equal(ledger.prune(DAY, new Set()), 1);
  assert.deepEqual(milestones(poll(ledger, [tls(13, [clock])], clock)), []);
});

test("older, equal, stale and future readings are not used and change nothing", () => {
  const cases: [string, number, number, boolean][] = [
    // [name, observedMs of the second reading, nowMs, used]
    ["older", 900, 1000, false],
    ["equal", 1000, 1000, false],
  ];
  for (const [name, observedMs, nowMs, used] of cases) {
    const ledger = memoryAlerts();
    assert.deepEqual(milestones(poll(ledger, [tls(3, [1000])], 1000)), [3]);
    const before = ledger.alertState("expiry", "x");
    poll(ledger, [tls(20, [observedMs])], nowMs);
    assert.deepEqual(ledger.alertState("expiry", "x"), before, name);
    assert.equal(ledger.alertState("expiry", "x")?.stage, used ? undefined : 3, name);
  }
  const fresh: [string, number, number][] = [
    ["stale by 1 ms", 180_001, 0],
    ["at the freshness limit", 180_000, 1],
    ["future by 1 ms", -60_001, 0],
    ["future at the limit", -60_000, 1],
  ];
  for (const [name, age, expected] of fresh) {
    const ledger = memoryAlerts();
    const nowMs = T0 + 1_000_000;
    assert.equal(poll(ledger, [tls(14, [nowMs - age])], nowMs).length, expected, name);
    assert.equal(ledger.alertStates("expiry").length, expected, name);
  }
});

test("a reading without days or locations is not used", () => {
  const ledger = memoryAlerts();
  assert.deepEqual(poll(ledger, [tls(null, [T0])], T0), []);
  assert.deepEqual(poll(ledger, [tls(10, [])], T0), []);
  assert.deepEqual(ledger.alertStates("expiry"), []);
});

test("the newest location gives the observation time: one event at 2000", () => {
  const ledger = memoryAlerts();
  const events = poll(ledger, [tls(10, [1000, 2000])], 2000);
  assert.deepEqual(
    events.map((e) => e.expiry),
    [{ daysLeft: 10, milestone: 14, observedMs: 2000 }],
  );
});

test("only subscribed kinds are evaluated, and a type change keeps the row", () => {
  const ledger = memoryAlerts();
  const tlsOnly = expiryAlerts(
    [domain(13, [T0])],
    () => undefined,
    { tls: true, domain: false },
    T0,
  );
  assert.deepEqual(tlsOnly, { notifications: [], changes: [] });
  assert.deepEqual(milestones(poll(ledger, [tls(13, [T0])], T0)), [14]);
  const events = poll(ledger, [domain(3, [T0 + 60_000])], T0 + 60_000);
  assert.deepEqual(
    events.map((e) => [e.event, e.key]),
    [["domain-expiry", `expiry:${T0}:3:${HASH_X}`]],
  );
});

test("the restart-safe ordering table", () => {
  const file = newFile();
  let ledger = ledgerAt(file);
  const step = (nowMs: number, days: number, observedMs: number): number[] =>
    milestones(poll(ledger, [tls(days, [observedMs])], nowMs));
  assert.deepEqual(step(T0, 2, T0), [3]);
  assert.equal(ledger.alertState("expiry", "x")?.stage, 3);
  assert.equal(ledger.alertState("expiry", "x")?.observedAt, T0);
  assert.deepEqual(step(T0 + 120_000, 2, T0 + 120_000), []);
  assert.equal(ledger.alertState("expiry", "x")?.observedAt, T0 + 120_000);
  ledger.close();
  ledger = ledgerAt(file);
  assert.equal(ledger.alertState("expiry", "x")?.observedAt, T0 + 120_000);
  assert.deepEqual(step(T0 + 150_000, 90, T0 + 60_000), []);
  assert.equal(ledger.alertState("expiry", "x")?.stage, 3);
  assert.deepEqual(step(T0 + 160_000, 13, T0 + 125_000), []);
  assert.deepEqual(step(T0 + 300_000, 90, T0 + 290_000), []);
  assert.equal(ledger.alertState("expiry", "x")?.stage, undefined);
  assert.deepEqual(step(T0 + 360_000, 14, T0 + 350_000), [14]);
});
