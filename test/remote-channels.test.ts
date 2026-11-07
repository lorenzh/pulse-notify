import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type NotifyChannelRecord,
  type Validation,
  validateServiceNotifyChannels,
} from "@lorenzh/pulse-contract";
import { ApiReadError, fetchChecks, getService, SERVICE_MAX_BYTES } from "../src/api.ts";
import { ChannelSync, type ChannelSyncOptions } from "../src/channel-sync.ts";
import { parseConfig } from "../src/config.ts";
import { Ledger } from "../src/ledger.ts";
import { Notifier } from "../src/notifier.ts";
import {
  type ChannelsAnswer,
  canonicalDefinition,
  checkChannelsAnswer,
  cutText,
  resolveDatabaseChannel,
  type SecretContext,
} from "../src/remote-channels.ts";
import type { Schedule } from "../src/types.ts";
import {
  type FakeApi,
  incident,
  type Receiver,
  type SpyLogger,
  spyLogger,
  startFakeApi,
  startReceiver,
} from "./support.ts";

const REV = `sha256-${"1".repeat(64)}`;
const TOKEN = "sentinel-service-token-0123456789";
const SECRET = "https://sentinel-secret.invalid/hook";

const dir = mkdtempSync(join(tmpdir(), "notify-remote-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const stamps = { createdAt: 1, updatedAt: 2 };

/** A webhook definition padded with check names to exactly `bytes` bytes of JSON. */
function sized(id: string, bytes: number): Record<string, unknown> {
  const def: Record<string, unknown> = {
    id,
    type: "webhook",
    urlEnv: "PULSE_NOTIFY_SECRET_B",
    checks: [] as string[],
  };
  const checks = def.checks as string[];
  let size = Buffer.byteLength(JSON.stringify(def));
  while (bytes - size > 0) {
    // Each further entry adds its length plus two quotes and (after the first) one comma.
    const overhead = checks.length === 0 ? 2 : 3;
    const room = Math.min(200, bytes - size - overhead);
    checks.push("x".repeat(Math.max(room, 1)));
    size = Buffer.byteLength(JSON.stringify(def));
  }
  return def;
}

const A = { id: "a", type: "webhook", urlEnv: "PULSE_NOTIFY_SECRET_A", ...stamps };
const C = { id: "c", type: "webhook", urlFile: "c.url", checks: ["api"], ...stamps };

function applied(answer: ChannelsAnswer): Extract<ChannelsAnswer, { kind: "applied" }> {
  assert.equal(answer.kind, "applied");
  return answer as Extract<ChannelsAnswer, { kind: "applied" }>;
}

test("a valid envelope with an oversized element rejects only that id", () => {
  const b = sized("b", 16_385);
  assert.equal(Buffer.byteLength(JSON.stringify(b)), 16_385);
  const answer = { revision: REV, channels: [A, { ...b, ...stamps }, C] };
  assert.equal(validateServiceNotifyChannels(answer).ok, true);
  const out = applied(checkChannelsAnswer(answer));
  assert.equal(out.revision, REV);
  assert.deepEqual(
    out.records.map((r) => r.id),
    ["a", "c"],
  );
  assert.deepEqual(out.rejected, [
    { channelId: "b", reason: "channels[1]: must be at most 16384 bytes as JSON" },
  ]);
});

test("a definition of exactly 16384 bytes is accepted; timestamps do not count", () => {
  const b = sized("b", 16_384);
  assert.equal(Buffer.byteLength(JSON.stringify(b)), 16_384);
  const out = applied(checkChannelsAnswer({ revision: REV, channels: [{ ...b, ...stamps }] }));
  assert.deepEqual(
    out.records.map((r) => r.id),
    ["b"],
  );
  assert.deepEqual(out.rejected, []);
});

test("an envelope failure is one rejection with channelId null and no element check", () => {
  const many = Array.from({ length: 101 }, (_, i) => ({ ...A, id: `c${i}` }));
  const cases: [string, unknown, string][] = [
    [
      "101 elements",
      { revision: REV, channels: many },
      "channels answer: channels: must hold at most 100 channels",
    ],
    [
      "id a twice",
      { revision: REV, channels: [A, A] },
      "channels answer: channels[1].id: must not repeat an id",
    ],
    [
      "missing id",
      { revision: REV, channels: [{ type: "webhook" }] },
      "channels answer: channels[0].id: is required",
    ],
    [
      "invalid id",
      { revision: REV, channels: [{ ...A, id: "A" }] },
      "channels answer: channels[0].id: must match ^[a-z0-9][a-z0-9_-]{0,63}$",
    ],
    [
      "array element",
      { revision: REV, channels: [[A]] },
      "channels answer: channels[0]: must be an object",
    ],
    [
      "unknown top-level key",
      { revision: REV, channels: [], extra: 1 },
      "channels answer: has an unknown field: extra",
    ],
    ["missing revision", { channels: [A] }, "channels answer: revision: is required"],
    ["not an object", "x", "channels answer: must be an object"],
  ];
  for (const [name, body, reason] of cases) {
    assert.deepEqual(
      checkChannelsAnswer(body),
      { kind: "envelope", rejected: { channelId: null, reason } },
      name,
    );
  }
});

test("database references follow the notify rules; secrets and other types are refused", () => {
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["urlEnv PULSE_API_TOKEN", { urlEnv: "PULSE_API_TOKEN" }, /urlEnv: must match/],
    ["urlEnv PULSE_NOTIFY_API_TOKEN", { urlEnv: "PULSE_NOTIFY_API_TOKEN" }, /urlEnv: must match/],
    ["urlFile ../api/token", { urlFile: "../api/token" }, /urlFile: must match/],
    ["urlFile a/b", { urlFile: "a/b" }, /urlFile: must match/],
    ["urlFile .", { urlFile: "." }, /urlFile: must match/],
    ["literal url", { urlEnv: "PULSE_NOTIFY_SECRET_A", url: SECRET }, /unknown field: url/],
    [
      "literal secret",
      { urlEnv: "PULSE_NOTIFY_SECRET_A", secret: SECRET },
      /unknown field: secret/,
    ],
    [
      "literal password",
      { urlEnv: "PULSE_NOTIFY_SECRET_A", password: SECRET },
      /unknown field: password/,
    ],
    ["type file", { type: "file", path: "out.jsonl" }, /type/],
  ];
  for (const [name, over, reason] of cases) {
    const element = { id: "z", type: "webhook", ...over, ...stamps };
    const out = applied(checkChannelsAnswer({ revision: REV, channels: [A, element] }));
    assert.deepEqual(
      out.records.map((r) => r.id),
      ["a"],
      name,
    );
    assert.equal(out.rejected.length, 1, name);
    assert.equal(out.rejected[0]?.channelId, "z", name);
    assert.match(out.rejected[0]?.reason ?? "", reason, name);
    assert.equal(out.rejected[0]?.reason.includes(SECRET), false, name);
  }
});

test("the cut rule keeps at most the limit and never splits a surrogate pair", () => {
  assert.equal(cutText("a".repeat(300), 300), "a".repeat(300));
  assert.equal(cutText("a".repeat(301), 300), `${"a".repeat(299)}…`);
  assert.equal(cutText(`${"a".repeat(198)}😀`, 200), `${"a".repeat(198)}😀`);
  assert.equal(cutText(`${"a".repeat(199)}😀`, 200), `${"a".repeat(199)}…`);
  assert.equal(cutText(`${"a".repeat(198)}😀b`, 200), `${"a".repeat(198)}…`);
});

test("the canonical definition sorts keys and leaves out the timestamps", () => {
  const record = { ...C } as NotifyChannelRecord;
  assert.equal(
    canonicalDefinition(record),
    '{"checks":["api"],"id":"c","type":"webhook","urlFile":"c.url"}',
  );
});

function secretDir(): string {
  const d = mkdtempSync(join(dir, "secrets-"));
  writeFileSync(join(d, "hook.url"), `${SECRET}\n`);
  writeFileSync(join(d, "empty"), "\n");
  writeFileSync(join(dir, "outside"), SECRET);
  symlinkSync(join(dir, "outside"), join(d, "escape"));
  mkdirSync(join(d, "sub"));
  writeFileSync(join(d, "sub", "inner"), SECRET);
  return d;
}

function ctx(over: Partial<SecretContext> = {}): SecretContext {
  return {
    env: { PULSE_NOTIFY_SECRET_A: SECRET, PULSE_NOTIFY_SECRET_EMPTY: "" },
    secretDir: undefined,
    realpath: realpathSync,
    readFile: (p) => readFileSync(p, "utf8"),
    ...over,
  };
}

function record(over: Record<string, unknown>): NotifyChannelRecord {
  const out = checkChannelsAnswer({
    revision: REV,
    channels: [{ id: "h", type: "webhook", ...over, ...stamps }],
  });
  const [first] = applied(out).records;
  assert.notEqual(first, undefined);
  return first as NotifyChannelRecord;
}

test("a database channel resolves from an allowed env name or a file in the secret directory", () => {
  const env = resolveDatabaseChannel(record({ urlEnv: "PULSE_NOTIFY_SECRET_A" }), ctx());
  assert.deepEqual(env, { ok: true, config: { id: "h", type: "webhook", url: SECRET } });
  const d = secretDir();
  const file = resolveDatabaseChannel(record({ urlFile: "hook.url" }), ctx({ secretDir: d }));
  assert.deepEqual(file, { ok: true, config: { id: "h", type: "webhook", url: SECRET } });
});

test("unusable references are refused with the reference named and no value", () => {
  const d = secretDir();
  const unreadable = (): string => {
    throw Object.assign(new Error(`EACCES ${SECRET}`), { code: "EACCES" });
  };
  const cases: [string, Record<string, unknown>, Partial<SecretContext>, string][] = [
    ["no secret dir", { urlFile: "hook.url" }, {}, 'channel "h": secret files are not enabled'],
    [
      "symlink outside",
      { urlFile: "escape" },
      { secretDir: d },
      'channel "h": urlFile: escape is outside the secret directory',
    ],
    [
      "missing file",
      { urlFile: "nope" },
      { secretDir: d },
      'channel "h": urlFile: cannot read file nope',
    ],
    [
      "empty file",
      { urlFile: "empty" },
      { secretDir: d },
      'channel "h": urlFile: empty is missing or empty',
    ],
    [
      "unreadable file",
      { urlFile: "hook.url" },
      { secretDir: d, readFile: unreadable },
      'channel "h": urlFile: cannot read file hook.url',
    ],
    [
      "missing env",
      { urlEnv: "PULSE_NOTIFY_SECRET_NONE" },
      {},
      'channel "h": urlEnv: PULSE_NOTIFY_SECRET_NONE is missing or empty',
    ],
    [
      "empty env",
      { urlEnv: "PULSE_NOTIFY_SECRET_EMPTY" },
      {},
      'channel "h": urlEnv: PULSE_NOTIFY_SECRET_EMPTY is missing or empty',
    ],
    [
      "secret file without dir",
      { urlEnv: "PULSE_NOTIFY_SECRET_A", secretFile: "s" },
      {},
      'channel "h": secret files are not enabled',
    ],
  ];
  for (const [name, over, context, reason] of cases) {
    const out = resolveDatabaseChannel(record(over), ctx(context));
    assert.deepEqual(out, { ok: false, rejected: { channelId: "h", reason } }, name);
  }
});

test("a sub directory in the secret directory is not a basename and stays refused", () => {
  const out = checkChannelsAnswer({
    revision: REV,
    channels: [{ id: "h", type: "webhook", urlFile: "sub/inner", ...stamps }],
  });
  assert.deepEqual(applied(out).records, []);
});

const isEnvelope = (raw: unknown): Validation<unknown> => validateServiceNotifyChannels(raw);

test("service reads send Bearer and If-None-Match; public reads send no Authorization", async () => {
  const api = await startFakeApi();
  try {
    api.notifyChannels = { etag: '"e1"', body: { revision: REV, channels: [] } };
    const opts = { baseUrl: api.url, token: TOKEN };
    const first = await getService(opts, "service/notify/channels", isEnvelope);
    assert.deepEqual(first, { status: "ok", value: { revision: REV, channels: [] }, etag: '"e1"' });
    const second = await getService(opts, "service/notify/channels", isEnvelope, '"e1"');
    assert.deepEqual(second, { status: "not-modified" });
    await fetchChecks({ baseUrl: api.url });
    assert.deepEqual(api.authorizations, [
      { path: "/service/notify/channels", authorization: `Bearer ${TOKEN}` },
      { path: "/service/notify/channels", authorization: `Bearer ${TOKEN}` },
      { path: "/checks", authorization: undefined },
    ]);
  } finally {
    await api.close();
  }
});

test("service reads refuse oversized, wrong-wire, malformed and redirected answers", async () => {
  const api = await startFakeApi();
  const path = "/service/notify/channels";
  const opts = { baseUrl: api.url, token: TOKEN };
  const big = JSON.stringify({ revision: REV, channels: [], pad: "x".repeat(SERVICE_MAX_BYTES) });
  const cases: [
    string,
    { status?: number; headers?: Record<string, string>; body?: string },
    RegExp,
  ][] = [
    ["over 1048576 bytes", { body: big }, /larger than 1048576 bytes/],
    [
      "wire mismatch",
      { headers: { "x-pulse-contract": "9" }, body: "{}" },
      /wire version mismatch/,
    ],
    ["bad shape", { body: JSON.stringify({ revision: REV }) }, /returned an invalid answer/],
    ["redirect", { status: 302, headers: { location: "/elsewhere" } }, /returned 302/],
  ];
  try {
    assert.equal(SERVICE_MAX_BYTES, 1_048_576);
    for (const [name, raw, message] of cases) {
      api.raw.set(path, raw);
      await assert.rejects(
        getService(opts, "service/notify/channels", isEnvelope),
        (err: unknown) =>
          err instanceof ApiReadError &&
          message.test(err.message) &&
          !err.message.includes(TOKEN) &&
          !err.message.includes("x".repeat(20)),
        name,
      );
    }
    assert.equal(api.requested.includes("/elsewhere"), false);
  } finally {
    await api.close();
  }
});

const R1 = `sha256-${"a".repeat(64)}`;
const R2 = `sha256-${"b".repeat(64)}`;
const R3 = `sha256-${"c".repeat(64)}`;
const R4 = `sha256-${"d".repeat(64)}`;
const SYNC_NOW = Date.UTC(2026, 0, 1, 13, 0, 0);

interface Harness {
  api: FakeApi;
  ledger: Ledger;
  notifier: Notifier;
  sync: ChannelSync;
  receivers: Record<"a" | "b1" | "b4" | "c", Receiver>;
  /** The status of every channels read, in order. */
  statuses: number[];
  logger: SpyLogger;
  clock: { now: number };
  close(): Promise<void>;
}

async function harness(
  statePath = join(mkdtempSync(join(dir, "sync-")), "state.sqlite"),
): Promise<Harness> {
  const api = await startFakeApi();
  const receivers = {
    a: await startReceiver(),
    b1: await startReceiver(),
    b4: await startReceiver(),
    c: await startReceiver(),
  };
  const env = {
    PULSE_NOTIFY_SECRET_A: receivers.a.url,
    PULSE_NOTIFY_SECRET_B: receivers.b1.url,
    PULSE_NOTIFY_SECRET_B4: receivers.b4.url,
    PULSE_NOTIFY_SECRET_C: receivers.c.url,
  };
  const clock = { now: SYNC_NOW };
  const ledger = new Ledger(statePath, { now: () => clock.now });
  const logger = spyLogger();
  const notifier = new Notifier({
    config: { channels: [] },
    apiUrl: api.url,
    ledger,
    logger,
    now: () => clock.now,
    sleep: () => Promise.resolve(),
    schedule: () => () => {},
  });
  const statuses: number[] = [];
  const recording: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const response = await fetch(input, init);
      statuses.push(response.status);
      return response;
    },
    { preconnect: fetch.preconnect },
  );
  const sync = new ChannelSync({
    ledger,
    install: (channels) => notifier.reconcile(channels),
    parseFile: () => [],
    fetchChannels: (etag) =>
      getService(
        { baseUrl: api.url, token: TOKEN, fetch: recording },
        "service/notify/channels",
        (raw) => ({ ok: true, value: raw }),
        etag,
      ),
    secrets: { env, secretDir: undefined, realpath: realpathSync, readFile: () => "" },
    now: () => clock.now,
    logger,
  });
  const h: Harness = {
    api,
    ledger,
    notifier,
    sync,
    receivers,
    statuses,
    logger,
    clock,
    close: async () => {
      await sync.stop();
      await notifier.stop();
      ledger.close();
      await api.close();
      for (const r of Object.values(receivers)) await r.close();
    },
  };
  return h;
}

const SA = { id: "a", type: "webhook", urlEnv: "PULSE_NOTIFY_SECRET_A", ...stamps };
const SB1 = { id: "b", type: "slack", urlEnv: "PULSE_NOTIFY_SECRET_B", ...stamps };
const SC1 = { id: "c", type: "webhook", urlEnv: "PULSE_NOTIFY_SECRET_C", ...stamps };
const SC2 = { ...SC1, checks: ["api"] };
const SB2 = { ...sized("b", 16_385), ...stamps };
const SB4 = { id: "b", type: "webhook", urlEnv: "PULSE_NOTIFY_SECRET_B4", ...stamps };

function serve(h: Harness, etag: string, revision: string, channels: unknown[]): void {
  h.api.raw.delete("/service/notify/channels");
  h.api.notifyChannels = { etag, body: { revision, channels } };
}

function installed(h: Harness): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of h.notifier.channels()) out[c.id] = "url" in c ? `${c.type} ${c.url}` : c.type;
  return out;
}

function rows(h: Harness): Record<string, string> {
  return Object.fromEntries(h.ledger.remoteChannels().map((r) => [r.id, r.revision]));
}

/** Whole-envelope failures: each keeps every worker, row, ETag and revision of r2. */
const envelopeCases: [string, (h: Harness) => void, RegExp][] = [
  [
    "r3 with 101 elements",
    (h) =>
      serve(
        h,
        '"r3"',
        R3,
        Array.from({ length: 101 }, (_, i) => ({ ...SA, id: `x${i}` })),
      ),
    /^channels answer/,
  ],
  ["r3 with a duplicate a", (h) => serve(h, '"r3"', R3, [SA, SA]), /^channels answer/],
  [
    "a body of 1048577 bytes",
    (h) => h.api.raw.set("/service/notify/channels", { body: "x".repeat(1_048_577) }),
    /^$/,
  ],
  [
    "a wire mismatch",
    (h) =>
      h.api.raw.set("/service/notify/channels", {
        headers: { "x-pulse-contract": "9" },
        body: JSON.stringify({ revision: R3, channels: [] }),
      }),
    /^$/,
  ],
  ["invalid JSON", (h) => h.api.raw.set("/service/notify/channels", { body: "{" }), /^$/],
];

test("the r1-r4 table: whole envelope rollback, per-element last good, 304 and recovery", async () => {
  const h = await harness();
  try {
    // r1: three valid channels install.
    serve(h, '"r1"', R1, [SA, SB1, SC1]);
    await h.sync.poll();
    await h.notifier.idle();
    const { a, b1, b4, c } = h.receivers;
    assert.deepEqual(installed(h), {
      a: `webhook ${a.url}`,
      b: `slack ${b1.url}`,
      c: `webhook ${c.url}`,
    });
    assert.equal(h.sync.state().appliedRevision, R1);
    assert.deepEqual(h.sync.state().rejected, []);
    const bRow = h.ledger.remoteChannels().find((r) => r.id === "b");

    // r2: b is too large and keeps r1; c's routing changes.
    h.clock.now = SYNC_NOW + 60_000;
    serve(h, '"r2"', R2, [SA, SB2, SC2]);
    await h.sync.poll();
    await h.notifier.idle();
    const r2Rejected = [
      { channelId: "b", reason: "channels[1]: must be at most 16384 bytes as JSON" },
    ];
    assert.deepEqual(installed(h), {
      a: `webhook ${a.url}`,
      b: `slack ${b1.url}`,
      c: `webhook ${c.url}`,
    });
    assert.deepEqual(h.notifier.channels().find((x) => x.id === "c")?.checks, ["api"]);
    assert.deepEqual(h.sync.state().rejected, r2Rejected);
    assert.equal(h.sync.state().appliedRevision, R2);
    assert.deepEqual(rows(h), { a: R2, b: R1, c: R2 });
    assert.deepEqual(
      h.ledger.remoteChannels().find((r) => r.id === "b"),
      bRow,
    );
    assert.equal(h.ledger.remoteChannels().find((r) => r.id === "a")?.appliedAt, SYNC_NOW + 60_000);

    // A new incident reaches b at its r1 destination.
    await h.notifier.tick();
    h.api.incidents = [incident({ id: 1, checkId: "api" })];
    await h.notifier.tick();
    await h.notifier.idle();
    assert.equal(b1.requests.length, 1);
    assert.equal(a.requests.length, 1);
    assert.equal(c.requests.length, 1);

    // The next poll sends the r2 ETag, gets 304 and keeps the rejection.
    h.statuses.length = 0;
    await h.sync.poll();
    assert.deepEqual(h.statuses, [304]);
    assert.deepEqual(h.sync.state().rejected, r2Rejected);
    assert.equal(h.notifier.channels().find((x) => x.id === "b")?.type, "slack");

    // r3 and broken answers change nothing; the stored ETag stays r2.
    for (const [name, arrange, reason] of envelopeCases) {
      arrange(h);
      await h.sync.poll();
      assert.deepEqual(rows(h), { a: R2, b: R1, c: R2 }, name);
      assert.equal(h.sync.state().appliedRevision, R2, name);
      assert.equal(
        Object.keys(installed(h))
          .sort((x, y) => x.localeCompare(y))
          .join(","),
        "a,b,c",
        name,
      );
      const rejected = h.sync.state().rejected;
      if (reason.source !== "^$") {
        assert.equal(rejected.length, 1, name);
        assert.equal(rejected[0]?.channelId, null, name);
        assert.match(rejected[0]?.reason ?? "", reason, name);
      }
      serve(h, '"r2"', R2, [SA, SB2, SC2]);
      h.statuses.length = 0;
      await h.sync.poll();
      assert.deepEqual(h.statuses, [304], name);
    }

    // r4: a valid b installs and clears the rejection.
    serve(h, '"r4"', R4, [SA, SB4, SC2]);
    await h.sync.poll();
    await h.notifier.idle();
    assert.equal(installed(h).b, `webhook ${b4.url}`);
    assert.deepEqual(h.sync.state().rejected, []);
    assert.deepEqual(rows(h), { a: R4, b: R4, c: R4 });
    assert.equal(
      h.logger.entries.some((e) => JSON.stringify(e).includes(TOKEN)),
      false,
    );
  } finally {
    await h.close();
  }
});

test("a cold r2 installs only a and c and persists no b", async () => {
  const h = await harness();
  try {
    serve(h, '"r2"', R2, [SA, SB2, SC2]);
    await h.sync.poll();
    assert.deepEqual(Object.keys(installed(h)), ["a", "c"]);
    assert.deepEqual(rows(h), { a: R2, c: R2 });
  } finally {
    await h.close();
  }
});

test("a missing secret keeps the last good version or installs nothing; neighbors apply", async () => {
  const h = await harness();
  try {
    serve(h, '"r1"', R1, [SA, SC1]);
    await h.sync.poll();
    const missing = { urlEnv: "PULSE_NOTIFY_SECRET_MISSING" };
    serve(h, '"r2"', R2, [{ ...SA, ...missing }, SC2, { ...SB4, ...missing }]);
    await h.sync.poll();
    assert.deepEqual(installed(h), {
      a: `webhook ${h.receivers.a.url}`,
      c: `webhook ${h.receivers.c.url}`,
    });
    assert.deepEqual(h.notifier.channels().find((x) => x.id === "c")?.checks, ["api"]);
    assert.deepEqual(rows(h), { a: R1, c: R2 });
    assert.deepEqual(
      h.sync.state().rejected.map((r) => r.channelId),
      ["a", "b"],
    );
    assert.equal(h.sync.state().appliedRevision, R2);
  } finally {
    await h.close();
  }
});

test("a cold start while the api is down resolves the stored definitions locally", async () => {
  const path = join(mkdtempSync(join(dir, "cold-")), "state.sqlite");
  const first = await harness(path);
  serve(first, '"r1"', R1, [SA, SC1]);
  await first.sync.poll();
  await first.close();
  const h = await harness(path);
  try {
    h.api.failing = true;
    await h.notifier.reconcile(h.sync.restore());
    await h.sync.poll();
    assert.deepEqual(installed(h), {
      a: `webhook ${h.receivers.a.url}`,
      c: `webhook ${h.receivers.c.url}`,
    });
    assert.deepEqual(rows(h), { a: R1, c: R1 });
  } finally {
    await h.close();
  }
});

test("an api without channels gives an empty remote layer and logs once", async () => {
  const h = await harness();
  try {
    serve(h, '"r1"', R1, [SA]);
    await h.sync.poll();
    h.api.notifyChannels = undefined;
    await h.sync.poll();
    await h.sync.poll();
    assert.deepEqual(installed(h), {});
    const lines = h.logger.entries.filter((e) => /no database channels/.test(e.msg));
    assert.equal(lines.length, 1);
  } finally {
    await h.close();
  }
});

test("the file is re-read at every poll, also on 304 and without a token", async () => {
  const api = await startFakeApi();
  const fileDir = mkdtempSync(join(dir, "file-"));
  const path = join(fileDir, "notify.json");
  const ledger = new Ledger(join(fileDir, "state.sqlite"));
  const logger = spyLogger();
  const installs: string[][] = [];
  let parses = 0;
  const file = (channels: unknown[]): void => writeFileSync(path, JSON.stringify({ channels }));
  const options = (fetchChannels: ChannelSyncOptions["fetchChannels"]): ChannelSyncOptions => ({
    ledger,
    install: (channels) => {
      installs.push(channels.map((c) => `${c.id}:${c.type}`));
    },
    readFile: () => readFileSync(path, "utf8"),
    parseFile: (text) => {
      parses++;
      return parseConfig(
        JSON.parse(text),
        path,
        { env: { SLACK_A: "https://hooks.invalid/a" }, readFile: () => "" },
        {
          allowEmpty: true,
        },
      ).channels;
    },
    fetchChannels,
    secrets: ctx({ env: { PULSE_NOTIFY_SECRET_A: SECRET } }),
    now: () => 1,
    logger,
  });
  try {
    // Token mode: a file Slack "a" shadows the database webhook "a" as a whole.
    api.notifyChannels = { etag: '"e"', body: { revision: REV, channels: [SA] } };
    const sync = new ChannelSync(
      options((etag) =>
        getService(
          { baseUrl: api.url, token: TOKEN },
          "service/notify/channels",
          (raw) => ({ ok: true, value: raw }),
          etag,
        ),
      ),
    );
    file([{ id: "a", type: "slack", urlEnv: "SLACK_A" }]);
    await sync.poll();
    assert.deepEqual(installs.at(-1), ["a:slack"]);
    assert.deepEqual(sync.state().shadowedIds, ["a"]);
    await sync.poll();
    assert.equal(parses, 1);
    // An invalid file, then a deleted one, keep the last good channels.
    writeFileSync(path, "{");
    await sync.poll();
    rmSync(path);
    await sync.poll();
    assert.deepEqual(installs.at(-1), ["a:slack"]);
    // A valid empty file removes the file channel and restores the database copy.
    file([]);
    await sync.poll();
    assert.deepEqual(installs.at(-1), ["a:webhook"]);
    assert.deepEqual(sync.state().shadowedIds, []);

    // Without a token: the file reloads and no service request is made.
    const before = api.requested.filter((p) => p.startsWith("/service/")).length;
    const tokenless = new ChannelSync(options(undefined));
    file([{ id: "t", type: "webhook", url: "https://hooks.invalid/t" }]);
    await tokenless.poll();
    file([{ id: "u", type: "webhook", url: "https://hooks.invalid/u" }]);
    await tokenless.poll();
    assert.deepEqual(installs.at(-1), ["u:webhook"]);
    assert.equal(api.requested.filter((p) => p.startsWith("/service/")).length, before);
  } finally {
    ledger.close();
    await api.close();
  }
});

test("the loop polls on its schedule until stopped", async () => {
  const timers: { fn: () => void; ms: number }[] = [];
  const schedule: Schedule = (fn, ms) => {
    const timer = { fn, ms };
    timers.push(timer);
    return () => timers.splice(timers.indexOf(timer), 1);
  };
  let installs = 0;
  const sync = new ChannelSync({
    ledger: { remoteChannels: () => [], replaceRemoteChannels: () => {} },
    install: () => {
      installs++;
    },
    parseFile: () => [],
    secrets: ctx(),
    now: () => 1,
    logger: spyLogger(),
  });
  sync.start(schedule, 15_000);
  assert.deepEqual(
    timers.map((t) => t.ms),
    [0],
  );
  timers.shift()?.fn();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(installs, 1);
  assert.deepEqual(
    timers.map((t) => t.ms),
    [15_000],
  );
  await sync.stop();
  assert.deepEqual(timers, []);
});
