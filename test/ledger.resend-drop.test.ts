import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SendMailResult } from "../src/channels/mailer.ts";
import { Ledger } from "../src/ledger.ts";
import { Notifier } from "../src/notifier.ts";
import { spyLogger } from "./support.ts";

const NOTE = {
  key: "1:opened",
  event: "opened" as const,
  incidentId: 1,
  checkId: "web",
  checkName: "Web",
  reason: null,
  time: "2026-01-01T00:00:00.000Z",
  timeMs: 1000,
  openedMs: 1000,
};

test("a recovered resend dropped by sendIncidents false finishes its command too", async () => {
  const dir = mkdtempSync(join(tmpdir(), "notify-review-drop-"));
  const path = join(dir, "state.sqlite");
  let ledger = new Ledger(path, { now: () => 1000 });
  const key = "1:opened";
  ledger.claim("a", key, NOTE);
  ledger.settle("a", key, "failed");
  ledger.admitResendCommand({ id: "AAAAAAAAAAAAAAAAAAAAAAA1", channelId: "a", key }, true);
  ledger.close();
  // Decision 14's crash after admission; recovery now has a warning-only channel.
  ledger = new Ledger(path, { now: () => 2000 });
  const notifier = new Notifier({
    config: {
      channels: [{ id: "a", type: "webhook", url: "http://127.0.0.1:1", sendIncidents: false }],
    },
    apiUrl: "http://127.0.0.1:1",
    ledger,
    now: () => 2000,
    logger: spyLogger(),
    schedule: () => () => {},
  });
  try {
    assert.equal(ledger.status("a", key), "dropped");
    assert.deepEqual(
      ledger.resendCommands().map((row) => row.state),
      ["dropped"],
    );
  } finally {
    await notifier.stop();
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("disabling incidents during a live resend finishes its dropped command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "notify-review-live-drop-"));
  const ledger = new Ledger(join(dir, "state.sqlite"), { now: () => 1000 });
  const key = "1:opened";
  ledger.claim("a", key, NOTE);
  ledger.settle("a", key, "failed");
  const response = Promise.withResolvers<SendMailResult>();
  const started = Promise.withResolvers<void>();
  const channel = {
    id: "a",
    type: "email" as const,
    smtp: { host: "127.0.0.1", port: 2525, tls: "none" as const },
    from: "pulse@example.org",
    to: ["ops@example.org"],
  };
  const notifier = new Notifier({
    config: { channels: [channel] },
    apiUrl: "http://127.0.0.1:1",
    ledger,
    now: () => 1000,
    logger: spyLogger(),
    schedule: () => () => {},
    sendMail: () => {
      started.resolve();
      return response.promise;
    },
  });
  try {
    notifier.start();
    ledger.admitResendCommand({ id: "AAAAAAAAAAAAAAAAAAAAAAA2", channelId: "a", key }, true);
    notifier.enqueueResent("a", key);
    await started.promise;
    const handover = notifier.reconcile([{ ...channel, sendIncidents: false }]);
    response.resolve({ accepted: ["ops@example.org"], refused: [] });
    await handover;
    await notifier.idle();
    assert.equal(ledger.status("a", key), "dropped");
    assert.deepEqual(
      ledger.resendCommands().map((row) => row.state),
      ["dropped"],
    );
  } finally {
    response.resolve({ accepted: ["ops@example.org"], refused: [] });
    await notifier.stop();
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
