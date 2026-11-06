import { test } from "bun:test";
import assert from "node:assert/strict";
import { validateNotifyServiceReport } from "@lorenzh/pulse-contract";
import type { FailedEntry } from "../src/ledger.ts";
import { buildServiceReport, failedEvent, type ReportInput } from "../src/service-report.ts";
import type { Notification } from "../src/types.ts";

const HEX = "0123456789abcdef0123456789abcdef";
const REV = `sha256-${"2".repeat(64)}`;

function base(over: Partial<ReportInput> = {}): ReportInput {
  return {
    at: 2000,
    startedAt: 1000,
    appliedRevision: REV,
    fileChannels: [],
    shadowedIds: [],
    rejected: [],
    failed: [],
    ...over,
  };
}

function checked(input: ReportInput): ReturnType<typeof buildServiceReport> {
  const report = buildServiceReport(input);
  const result = validateNotifyServiceReport(report);
  assert.equal(result.ok, true, JSON.stringify(result));
  return report;
}

// A stored payload is untrusted at this level: the ledger checks only that it is an object.
function payload(value: Record<string, unknown>): Notification {
  return value as unknown as Notification;
}

test("the cut rule applies to file ids, refs and rejected fields", () => {
  const cases: { ref: string; expected: string }[] = [
    { ref: `/${"a".repeat(200)}`, expected: `/${"a".repeat(198)}…` },
    { ref: "r".repeat(200), expected: "r".repeat(200) },
    { ref: `${"a".repeat(198)}😀`, expected: `${"a".repeat(198)}😀` },
    { ref: `${"a".repeat(199)}😀`, expected: `${"a".repeat(199)}…` },
  ];
  for (const { ref, expected } of cases) {
    const report = checked(
      base({ fileChannels: [{ id: "ops", type: "webhook", raw: { urlFile: ref } }] }),
    );
    assert.deepEqual(report.fileChannels[0]?.refs, [expected]);
  }
  const report = checked(
    base({
      fileChannels: [{ id: "x".repeat(201), type: "file", raw: {} }],
      rejected: [{ channelId: "y".repeat(201), reason: "r".repeat(301) }],
    }),
  );
  assert.equal(report.fileChannels[0]?.id, `${"x".repeat(199)}…`);
  assert.deepEqual(report.rejected[0], {
    channelId: `${"y".repeat(199)}…`,
    reason: `${"r".repeat(299)}…`,
  });
});

test("refs follow the R1 order and are names only", () => {
  const report = checked(
    base({
      fileChannels: [
        {
          id: "mail",
          type: "email",
          raw: {
            smtp: { passwordFile: "pw.txt", passwordEnv: "SMTP_PW", host: "h" },
            secretFile: "sig.txt",
            secretEnv: "SIG",
            urlFile: "hook.txt",
            urlEnv: "HOOK",
          },
        },
      ],
    }),
  );
  assert.deepEqual(report.fileChannels[0]?.refs, [
    "HOOK",
    "hook.txt",
    "SIG",
    "sig.txt",
    "SMTP_PW",
    "pw.txt",
  ]);
  assert.equal(report.fileChannelsTotal, 1);
});

test("an overlong failed key or channel id is left out but counted", () => {
  const report = checked(
    base({
      failed: [
        { channelId: "ops", key: "k".repeat(301), at: 5 },
        { channelId: "c".repeat(201), key: "1:opened", at: 6 },
        { channelId: "ops", key: "1:opened", at: 4 },
      ],
    }),
  );
  assert.deepEqual(report.failed, [
    {
      channelId: "ops",
      key: "1:opened",
      event: "opened",
      isManual: false,
      failedAt: 4,
      hasPayload: false,
    },
  ]);
  assert.equal(report.failedTotal, 3);
});

test("event and isManual follow the R1 table", () => {
  const rows: { key: string; payload?: Record<string, unknown>; event: string; manual: boolean }[] =
    [
      { key: "1:opened", payload: { event: "update", manual: {} }, event: "update", manual: true },
      { key: "x", payload: { event: "budget-low" }, event: "budget-low", manual: false },
      { key: "x", payload: { event: "tls-expiry" }, event: "tls-expiry", manual: false },
      { key: "x", payload: { event: "domain-expiry" }, event: "domain-expiry", manual: false },
      { key: "5:resolved", event: "resolved", manual: false },
      { key: "7:reminder:2", event: "reminder", manual: false },
      { key: `manual:3:update:${HEX}`, event: "update", manual: true },
      { key: `budget:check:1:${HEX}`, event: "budget-low", manual: false },
      { key: `expiry:1:14:${HEX}`, event: "unknown", manual: false },
      { key: "x", event: "unknown", manual: false },
      { key: "9:opened", payload: { event: "zzz" }, event: "opened", manual: false },
      {
        key: "manual:3:resolved",
        payload: { event: "zzz", manual: {} },
        event: "resolved",
        manual: true,
      },
      { key: `budget:check:1:${HEX}`, payload: {}, event: "budget-low", manual: false },
      { key: "x", payload: { event: "zzz" }, event: "unknown", manual: false },
      { key: "manual:3:opened", payload: { event: "update" }, event: "update", manual: false },
    ];
  for (const row of rows) {
    assert.deepEqual(failedEvent(row.key, row.payload), { event: row.event, isManual: row.manual });
    const entry: FailedEntry = { channelId: "ops", key: row.key, at: 1 };
    if (row.payload !== undefined) entry.notification = payload(row.payload);
    const report = checked(base({ failed: [entry] }));
    assert.deepEqual(report.failed[0], {
      channelId: "ops",
      key: row.key,
      event: row.event,
      isManual: row.manual,
      failedAt: 1,
      hasPayload: row.payload !== undefined,
    });
  }
});

test("failed is newest first and bounded; lists are capped; no payload values", () => {
  const failed: FailedEntry[] = Array.from({ length: 250 }, (_, i) => ({
    channelId: "ops",
    key: `${i}:opened`,
    at: i,
    notification: payload({ event: "opened", reason: "SENTINEL-PAYLOAD" }),
  }));
  const report = checked(
    base({
      failed,
      fileChannels: Array.from({ length: 210 }, (_, i) => ({
        id: `f${i}`,
        type: "webhook" as const,
        raw: { url: "https://SENTINEL-DEST.example/" },
      })),
      rejected: Array.from({ length: 120 }, (_, i) => ({ channelId: `r${i}`, reason: "bad" })),
      shadowedIds: Array.from({ length: 120 }, (_, i) => `s${i}`),
    }),
  );
  assert.equal(report.failed.length, 200);
  assert.equal(report.failed[0]?.failedAt, 249);
  assert.equal(report.failedTotal, 250);
  assert.equal(report.fileChannels.length, 200);
  assert.equal(report.fileChannelsTotal, 210);
  assert.equal(report.rejected.length, 100);
  assert.equal(report.shadowedIds.length, 100);
  const text = JSON.stringify(report);
  assert.equal(text.includes("SENTINEL"), false);
});

test("an escaped report is trimmed to 524288 bytes: failed, then file channels, then rejected", () => {
  const ctl = "\u0001";
  const report = checked(
    base({
      failed: Array.from({ length: 200 }, (_, i) => ({
        channelId: `${ctl.repeat(190)}${i}`,
        key: `${ctl.repeat(290)}${i}`,
        at: i,
      })),
      fileChannels: Array.from({ length: 200 }, (_, i) => ({
        id: `${ctl.repeat(190)}${i}`,
        type: "webhook" as const,
        raw: {
          urlEnv: ctl.repeat(200),
          urlFile: ctl.repeat(200),
          secretEnv: ctl.repeat(200),
          secretFile: ctl.repeat(200),
        },
      })),
      rejected: Array.from({ length: 100 }, (_, i) => ({
        channelId: `${ctl.repeat(190)}${i}`,
        reason: ctl.repeat(300),
      })),
    }),
  );
  const size = Buffer.byteLength(JSON.stringify(report), "utf8");
  assert.equal(size <= 524_288, true, String(size));
  assert.equal(report.failed.length, 0);
  assert.equal(report.failedTotal, 200);
  assert.equal(report.fileChannelsTotal, 200);
  assert.equal(report.fileChannels.length < 200, true);
  assert.equal(report.rejected.length, 100);
});
