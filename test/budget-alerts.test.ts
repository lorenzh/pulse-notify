import { afterAll, afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BudgetSubject, budgetAlerts } from "../src/budget-alerts.ts";
import { isAlertRouted } from "../src/channels/routing.ts";
import { Ledger } from "../src/ledger.ts";
import type { BudgetNotification, ChannelConfig } from "../src/types.ts";
import { type AlertStore, memoryAlerts, slo } from "./support.ts";

const dir = mkdtempSync(join(tmpdir(), "notify-budget-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const open: Ledger[] = [];
afterEach(() => {
  for (const ledger of open.splice(0)) ledger.close();
});

let counter = 0;
function newFile(): string {
  return join(dir, `state-${counter++}.json`);
}

function ledgerAt(file: string, now = 0): Ledger {
  const ledger = new Ledger(file, { now: () => now });
  open.push(ledger);
  return ledger;
}

const T0 = Date.UTC(2026, 0, 1, 23, 59, 0);
const HOUR = 3_600_000;
/** The first 32 hex characters of SHA-256("a"), from a published test vector. */
const HASH_A = "ca978112ca1bbdcafac231b39a23dc4d";

function check(budget: number | null, id = "a"): BudgetSubject {
  return { id, name: `Check ${id}`, slo: slo(budget) };
}

/** Evaluates the checks at `nowMs` and commits the changes, as one poll does. */
function poll(
  ledger: AlertStore,
  subjects: BudgetSubject[],
  nowMs: number,
  threshold = 25,
  kind: "check" | "component" = "check",
): BudgetNotification[] {
  const result = budgetAlerts(
    kind,
    subjects,
    (k, id) => ledger.alertState(k, id),
    threshold,
    nowMs,
  );
  ledger.applyAlerts(result.changes, []);
  return result.notifications;
}

test("only a budget strictly below the threshold fires, without rounding", () => {
  const cases: [string, BudgetSubject, number][] = [
    ["25", check(25), 0],
    ["24.999", check(24.999), 1],
    ["null", check(null), 0],
    ["no slo", { id: "a", name: "A" }, 0],
    ["0", check(0), 1],
    ["-50", check(-50), 1],
  ];
  for (const [name, subject, expected] of cases) {
    const ledger = memoryAlerts();
    assert.equal(poll(ledger, [subject], T0).length, expected, name);
  }
});

test("0 and -50 on separate checks give one event each", () => {
  const ledger = memoryAlerts();
  const events = poll(ledger, [check(0, "a"), check(-50, "b")], T0);
  assert.deepEqual(
    events.map((e) => e.subject.id),
    ["a", "b"],
  );
});

test("an event is due again after exactly 24 elapsed hours, not on a calendar day", () => {
  const ledger = memoryAlerts();
  assert.equal(poll(ledger, [check(10)], T0).length, 1);
  assert.equal(poll(ledger, [check(10)], T0 + 86_399_999).length, 0);
  assert.equal(poll(ledger, [check(10)], T0 + 86_400_000).length, 1);
});

test("a recovery and a new drop inside 24 hours send nothing", () => {
  const ledger = memoryAlerts();
  assert.equal(poll(ledger, [check(10)], T0).length, 1);
  assert.equal(poll(ledger, [check(80)], T0 + HOUR).length, 0);
  assert.equal(poll(ledger, [check(10)], T0 + 2 * HOUR).length, 0);
  assert.equal(poll(ledger, [check(10)], T0 + 23 * HOUR).length, 0);
  assert.deepEqual(ledger.alertState("budget-check", "a")?.lastEventAt, T0);
});

test("the suppression survives a ledger reopen and a threshold change", () => {
  const file = newFile();
  const first = ledgerAt(file);
  assert.equal(poll(first, [check(10)], T0).length, 1);
  first.close();
  const again = ledgerAt(file);
  assert.equal(poll(again, [check(10)], T0 + HOUR).length, 0);
  assert.equal(poll(again, [check(40)], T0 + 2 * HOUR, 50).length, 0);
});

test("a clock that steps back sends nothing", () => {
  const ledger = memoryAlerts();
  assert.equal(poll(ledger, [check(10)], T0).length, 1);
  assert.equal(poll(ledger, [check(10)], T0 - 1000).length, 0);
});

test("missed days during downtime give exactly one event", () => {
  const ledger = memoryAlerts();
  assert.equal(poll(ledger, [check(10)], T0).length, 1);
  assert.equal(poll(ledger, [check(10)], T0 + 72 * HOUR).length, 1);
  assert.equal(poll(ledger, [check(10)], T0 + 72 * HOUR + 1000).length, 0);
});

test("a check and a component with the same id are two SLOs with two keys", () => {
  const ledger = memoryAlerts();
  const [c] = poll(ledger, [check(10)], T0);
  const [k] = poll(ledger, [check(10)], T0, 25, "component");
  assert.equal(c?.key, `budget:check:${T0}:${HASH_A}`);
  assert.equal(k?.key, `budget:component:${T0}:${HASH_A}`);
  assert.deepEqual(k?.subject, { kind: "component", id: "a", name: "Check a" });
  assert.equal(ledger.alertStates("budget-check").length, 1);
  assert.equal(ledger.alertStates("budget-component").length, 1);
});

test("the payload carries the raw api values and the threshold in force", () => {
  const ledger = memoryAlerts();
  const subject: BudgetSubject = {
    id: "api-health",
    name: "API health",
    slo: { target: 99.9, windowDays: 30, availability: 99.8816, budgetRemaining: 18.4 },
  };
  assert.deepEqual(poll(ledger, [subject], 1767268800000), [
    {
      key: "budget:check:1767268800000:d36882c163db780c0f14589fb2e06d3a",
      event: "budget-low",
      time: "2026-01-01T12:00:00.000Z",
      timeMs: 1767268800000,
      subject: { kind: "check", id: "api-health", name: "API health" },
      budget: {
        remaining: 18.4,
        threshold: 25,
        target: 99.9,
        availability: 99.8816,
        windowDays: 30,
      },
    },
  ]);
});

test("threshold 0: budget 0 sends nothing, -0.1 sends one event", () => {
  const ledger = memoryAlerts();
  assert.equal(poll(ledger, [check(0, "a")], T0, 0).length, 0);
  assert.equal(poll(ledger, [check(-0.1, "b")], T0, 0).length, 1);
});

test("one event on two channels: one alert row and one entry per channel with the same key", () => {
  const ledger = ledgerAt(newFile(), T0);
  const channels: ChannelConfig[] = [
    { id: "w1", type: "file", path: "/dev/null", alerts: ["budget-low"] },
    { id: "w2", type: "file", path: "/dev/null", alerts: ["budget-low"], sendIncidents: false },
    { id: "w3", type: "file", path: "/dev/null" },
  ];
  const result = budgetAlerts("check", [check(10)], (k, id) => ledger.alertState(k, id), 25, T0);
  const deliveries = result.notifications.flatMap((n) =>
    channels
      .filter((c) => isAlertRouted(c, n.event, n.subject))
      .map((c) => ({ channelId: c.id, key: n.key, notification: n })),
  );
  ledger.applyAlerts(result.changes, deliveries);
  assert.equal(ledger.alertStates("budget-check").length, 1);
  assert.deepEqual(
    ledger.pending().map((p) => [p.channelId, p.key]),
    [
      ["w1", `budget:check:${T0}:${HASH_A}`],
      ["w2", `budget:check:${T0}:${HASH_A}`],
    ],
  );
});

test("an id with a colon and a newline only reaches the key as a 32-hex hash", () => {
  const [note] = poll(memoryAlerts(), [check(10, "a:b\nc")], T0);
  assert.equal(note?.key, `budget:check:${T0}:af48efebd01d334bf450f00585e3acd6`);
});
