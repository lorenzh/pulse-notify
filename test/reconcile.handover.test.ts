import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getService } from "../src/api.ts";
import { ChannelSync } from "../src/channel-sync.ts";
import type { SendMail, SendMailResult } from "../src/channels/mailer.ts";
import { parseConfig } from "../src/config.ts";
import { main } from "../src/index.ts";
import { Ledger } from "../src/ledger.ts";
import { Notifier } from "../src/notifier.ts";
import type { ChannelConfig } from "../src/types.ts";
import { incident, spyLogger, startFakeApi } from "./support.ts";

const REVISION = `sha256-${"1".repeat(64)}`;
const NOW = Date.UTC(2026, 0, 1, 13);

function email(prefix: string): ChannelConfig {
  return {
    id: "mail",
    type: "email",
    smtp: { host: "127.0.0.1", port: 2525, tls: "none" },
    from: "notify@example.org",
    to: ["a@example.org", "b@example.org"],
    subjectPrefix: prefix,
  };
}

async function mailHandover(isPartial: boolean): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "notify-handover-handover-"));
  const api = await startFakeApi();
  const ledger = new Ledger(join(dir, "state.sqlite"), { now: () => NOW });
  const started = Promise.withResolvers<void>();
  const first = Promise.withResolvers<SendMailResult>();
  const envelopes: string[][] = [];
  const subjects: string[] = [];
  const sendMail: SendMail = (_smtp, message) => {
    envelopes.push(message.envelopeTo);
    subjects.push(message.subject);
    if (envelopes.length === 1) {
      started.resolve();
      return first.promise;
    }
    return Promise.resolve({ accepted: message.envelopeTo, refused: [] });
  };
  const notifier = new Notifier({
    config: { channels: [email("[old]")] },
    apiUrl: api.url,
    ledger,
    logger: spyLogger(),
    now: () => NOW,
    schedule: () => () => {},
    sleep: () => Promise.resolve(),
    sendMail,
  });
  try {
    notifier.start();
    await notifier.tick();
    api.incidents = isPartial ? [incident({ id: 1 })] : [incident({ id: 1 }), incident({ id: 2 })];
    await notifier.tick();
    await started.promise;
    assert.equal(envelopes.length, 1);
    const handover = notifier.reconcile([email("[new]")]);
    first.resolve(
      isPartial
        ? {
            accepted: ["a@example.org"],
            refused: [{ recipient: "b@example.org", responseCode: 451 }],
          }
        : { accepted: ["a@example.org", "b@example.org"], refused: [] },
    );
    await handover;
    await notifier.idle();
    if (isPartial) {
      assert.deepEqual(envelopes, [["a@example.org", "b@example.org"], ["b@example.org"]]);
    } else {
      assert.deepEqual(subjects, ["[old] DOWN: example", "[new] DOWN: example"]);
    }
  } finally {
    first.resolve({ accepted: ["a@example.org", "b@example.org"], refused: [] });
    await notifier.stop();
    ledger.close();
    await api.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("replacement retains progress from a partial SMTP send in flight", async () => {
  await mailHandover(true);
});

test("replacement transfers a ready event behind the send in flight", async () => {
  await mailHandover(false);
});

const brokenAnswers = [
  { name: "invalid JSON", body: "{", headers: {} },
  { name: "oversized body", body: "x".repeat(1_048_577), headers: {} },
  { name: "wire mismatch", body: "{}", headers: { "x-pulse-contract": "9" } },
];

for (const broken of brokenAnswers) {
  test(`${broken.name} reports one whole-answer rejection`, async () => {
    let isBroken = false;
    const fetchAnswer: typeof fetch = Object.assign(
      async () =>
        new Response(
          isBroken ? broken.body : JSON.stringify({ revision: REVISION, channels: [] }),
          {
            headers: isBroken ? broken.headers : { etag: '"r1"' },
          },
        ),
      { preconnect: fetch.preconnect },
    );
    const sync = new ChannelSync({
      ledger: { remoteChannels: () => [], replaceRemoteChannels: () => {} },
      install: () => {},
      parseFile: () => [],
      fetchChannels: (etag) =>
        getService(
          { baseUrl: "http://127.0.0.1:1/", token: "review-token", fetch: fetchAnswer },
          "service/notify/channels",
          (raw) => ({ ok: true, value: raw }),
          etag,
        ),
      secrets: { env: {}, secretDir: undefined, realpath: (p) => p, readFile: () => "" },
      now: () => NOW,
      logger: spyLogger(),
    });
    await sync.poll();
    isBroken = true;
    await sync.poll();
    assert.equal(sync.state().appliedRevision, REVISION);
    assert.equal(sync.state().rejected.length, 1);
    assert.equal(sync.state().rejected[0]?.channelId, null);
    assert.match(sync.state().rejected[0]?.reason ?? "", /^channels answer/);
  });
}

const brokenFiles = [
  { name: "invalid", read: () => "{", reason: "channel file: invalid, last good kept" },
  {
    name: "deleted",
    read: (): string => {
      throw new Error("ENOENT");
    },
    reason: "channel file: unreadable, last good kept",
  },
];

for (const broken of brokenFiles) {
  test(`an ${broken.name} channel file is reported while its last good channel stays`, async () => {
    let isBroken = false;
    const good = JSON.stringify({
      channels: [{ id: "local", type: "webhook", url: "http://127.0.0.1/hook" }],
    });
    const sync = new ChannelSync({
      ledger: { remoteChannels: () => [], replaceRemoteChannels: () => {} },
      install: () => {},
      readFile: () => (isBroken ? broken.read() : good),
      parseFile: (raw) =>
        parseConfig(JSON.parse(raw), "channels.json", undefined, { allowEmpty: true }).channels,
      secrets: { env: {}, secretDir: undefined, realpath: (p) => p, readFile: () => "" },
      now: () => NOW,
      logger: spyLogger(),
    });
    await sync.poll();
    isBroken = true;
    await sync.poll();
    assert.deepEqual(
      sync.state().fileChannels.map((c) => c.id),
      ["local"],
    );
    assert.deepEqual(sync.state().rejected, [{ channelId: null, reason: broken.reason }]);
    isBroken = false;
    await sync.poll();
    assert.deepEqual(sync.state().rejected, []);
  });
}

test("tokenless startup uses only file channels even after a token-mode run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "notify-handover-tokenless-"));
  const state = join(dir, "state.sqlite");
  const config = join(dir, "notify.json");
  const ledger = new Ledger(state, { now: () => NOW });
  ledger.replaceRemoteChannels([
    {
      id: "database",
      definition: JSON.stringify({
        id: "database",
        type: "webhook",
        urlEnv: "PULSE_NOTIFY_SECRET_HOOK",
      }),
      revision: REVISION,
      appliedAt: NOW,
    },
  ]);
  ledger.close();
  writeFileSync(
    config,
    JSON.stringify({ channels: [{ id: "local", type: "webhook", url: "http://127.0.0.1/hook" }] }),
  );
  let installed: string[] = [];
  const running = main(
    {
      PULSE_NOTIFY_CONFIG: config,
      PULSE_NOTIFY_STATE: state,
      PULSE_NOTIFY_SECRET_HOOK: "http://127.0.0.1/database-hook",
    },
    {
      now: () => NOW,
      logger: spyLogger(),
      channelSchedule: () => () => {},
      heartbeatSchedule: () => () => {},
      createNotifier: (options) => {
        installed = options.config.channels.map((c) => c.id);
        return { start() {}, stop: () => Promise.resolve() };
      },
    },
  );
  try {
    await running.listening;
    assert.deepEqual(installed, ["local"]);
  } finally {
    await running.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
