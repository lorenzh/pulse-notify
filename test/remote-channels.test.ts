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
import {
  type ChannelsAnswer,
  canonicalDefinition,
  checkChannelsAnswer,
  cutText,
  resolveDatabaseChannel,
  type SecretContext,
} from "../src/remote-channels.ts";
import { startFakeApi } from "./support.ts";

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
