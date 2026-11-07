import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StartupError } from "@lorenzh/pulse-kit";
import {
  ConfigError,
  loadBudgetThreshold,
  loadConfigFile,
  loadSettings,
  parseConfig,
} from "../src/config.ts";

const hook = { id: "h", type: "webhook", url: "https://example.com/x" };
const file = { id: "f", type: "file", path: "./out.jsonl" };

test("parseConfig accepts valid channels", () => {
  const config = parseConfig({ channels: [{ ...hook, checks: ["a"] }, file] });
  assert.equal(config.channels.length, 2);
  assert.deepEqual(config.channels[0]?.checks, ["a"]);
});

const invalid: [string, unknown, RegExp][] = [
  ["not an object", [], /must be an object/],
  ["null", null, /must be an object/],
  ["missing channels", {}, /non-empty array/],
  ["empty channels", { channels: [] }, /non-empty array/],
  ["channel not object", { channels: ["x"] }, /must be an object/],
  ["missing id", { channels: [{ type: "file", path: "p" }] }, /id/],
  ["duplicate id", { channels: [file, file] }, /duplicate channel id "f"/],
  ["unknown type", { channels: [{ id: "x", type: "sms" }] }, /unknown type "sms"/],
  ["webhook without url", { channels: [{ id: "x", type: "webhook" }] }, /valid http\(s\) url/],
  [
    "webhook bad scheme",
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- test needs a non-http scheme
    { channels: [{ id: "x", type: "webhook", url: "ftp://a/b" }] },
    /valid http\(s\) url/,
  ],
  [
    "webhook unparseable url",
    { channels: [{ id: "x", type: "webhook", url: "nope" }] },
    /valid http\(s\) url/,
  ],
  ["file without path", { channels: [{ id: "x", type: "file" }] }, /needs a path/],
  ["checks not array", { channels: [{ ...file, checks: "a" }] }, /array of strings/],
  ["checks with non-string", { channels: [{ ...file, checks: [1] }] }, /array of strings/],
];

test("parseConfig rejects unknown keys and names the path and key", () => {
  const cases: [unknown, string][] = [
    [{ channels: [file], chanels: [] }, 'cfg.json: unknown key "chanels" in config'],
    [{ channels: [{ ...file, check: ["a"] }] }, 'cfg.json: unknown key "check" in channels[0]'],
    [{ channels: [file, { ...hook, path: "x" }] }, 'cfg.json: unknown key "path" in channels[1]'],
    [{ channels: [{ ...file, url: "x" }] }, 'cfg.json: unknown key "url" in channels[0]'],
  ];
  for (const [raw, message] of cases) {
    assert.throws(
      () => parseConfig(raw, "cfg.json"),
      (err) => err instanceof ConfigError && err.message === message,
    );
  }
});

test("loadSettings reads log level and health listener settings", () => {
  const base = { PULSE_NOTIFY_CONFIG: "c" };
  const s = loadSettings({
    ...base,
    PULSE_LOG_LEVEL: "debug",
    PULSE_HEALTH_PORT: "9100",
    PULSE_HEALTH_HOST: "0.0.0.0",
  });
  assert.equal(s.logLevel, "debug");
  assert.equal(s.healthPort, 9100);
  assert.equal(s.healthHost, "0.0.0.0");
  assert.throws(() => loadSettings({ ...base, PULSE_LOG_LEVEL: "loud" }), /PULSE_LOG_LEVEL/);
  assert.throws(() => loadSettings({ ...base, PULSE_HEALTH_PORT: "70000" }), /PULSE_HEALTH_PORT/);
  assert.throws(() => loadSettings({ ...base, PULSE_HEALTH_PORT: "x" }), StartupError);
});

for (const [label, raw, pattern] of invalid) {
  test(`parseConfig rejects: ${label}`, () => {
    assert.throws(
      () => parseConfig(raw),
      (err) => err instanceof ConfigError && pattern.test(err.message),
    );
  });
}

test("loadConfigFile reports unreadable and malformed files", () => {
  const dir = mkdtempSync(join(tmpdir(), "notify-config-"));
  assert.throws(() => loadConfigFile(join(dir, "missing.json")), ConfigError);
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{nope");
  assert.throws(() => loadConfigFile(bad), /not valid JSON/);
  const good = join(dir, "good.json");
  writeFileSync(good, JSON.stringify({ channels: [file] }));
  assert.equal(loadConfigFile(good).channels[0]?.id, "f");
  rmSync(dir, { recursive: true, force: true });
});

test("loadSettings applies defaults and validates", () => {
  assert.throws(() => loadSettings({}), /PULSE_NOTIFY_CONFIG is required/);
  const s = loadSettings({ PULSE_NOTIFY_CONFIG: "c.json" });
  assert.deepEqual(s, {
    configPath: "c.json",
    apiToken: undefined,
    secretDir: undefined,
    channelsPollMs: 15000,
    commandPollMs: 5000,
    apiUrl: "http://localhost:3000",
    statePath: "./notify-state.json",
    pollMs: 5000,
    retryDelayMs: 1000,
    retryMaxDelayMs: 60000,
    retryAttempts: 12,
    timeoutMs: 5000,
    logLevel: "info",
    healthPort: undefined,
    healthHost: "127.0.0.1",
    healthMaxFailedPolls: 5,
    lockLeaseSeconds: 60,
    stateRetentionDays: 30,
    apiMaxBytes: 5242880,
    smtpClientName: undefined,
  });
  assert.equal(loadSettings({ PULSE_NOTIFY_CONFIG: "c", PULSE_NOTIFY_POLL_MS: "10" }).pollMs, 10);
  assert.throws(
    () => loadSettings({ PULSE_NOTIFY_CONFIG: "c", PULSE_NOTIFY_POLL_MS: "abc" }),
    StartupError,
  );
  assert.throws(
    () => loadSettings({ PULSE_NOTIFY_CONFIG: "c", PULSE_NOTIFY_TIMEOUT_MS: "0" }),
    StartupError,
  );
});

test("loadSettings parses the new limits and rejects values below their minimum", () => {
  const base = { PULSE_NOTIFY_CONFIG: "c" };
  const s = loadSettings({
    ...base,
    PULSE_NOTIFY_HEALTH_MAX_FAILED_POLLS: "2",
    PULSE_NOTIFY_LOCK_LEASE_SECONDS: "30",
    PULSE_NOTIFY_STATE_RETENTION_DAYS: "7",
    PULSE_NOTIFY_API_MAX_BYTES: "1000",
    PULSE_NOTIFY_SMTP_CLIENT_NAME: "pulse.example.com",
  });
  assert.equal(s.healthMaxFailedPolls, 2);
  assert.equal(s.lockLeaseSeconds, 30);
  assert.equal(s.stateRetentionDays, 7);
  assert.equal(s.apiMaxBytes, 1000);
  assert.equal(s.smtpClientName, "pulse.example.com");
  for (const name of [
    "PULSE_NOTIFY_HEALTH_MAX_FAILED_POLLS",
    "PULSE_NOTIFY_STATE_RETENTION_DAYS",
    "PULSE_NOTIFY_API_MAX_BYTES",
  ]) {
    assert.throws(() => loadSettings({ ...base, [name]: "0" }), /at least/, name);
  }
  assert.throws(
    () => loadSettings({ ...base, PULSE_NOTIFY_LOCK_LEASE_SECONDS: "29" }),
    StartupError,
  );
  assert.throws(
    () => loadSettings({ ...base, PULSE_NOTIFY_SMTP_CLIENT_NAME: "bad name" }),
    StartupError,
  );
});

test("PULSE_API_URL errors never echo the url", () => {
  const url = "file://user:secret@host/p?token=x";
  assert.throws(
    () => loadSettings({ PULSE_NOTIFY_CONFIG: "c", PULSE_API_URL: url }),
    (err: Error) => !/secret|token/.test(err.message) && err instanceof StartupError,
  );
  assert.throws(
    () => loadSettings({ PULSE_NOTIFY_CONFIG: "c", PULSE_API_URL: "user:secret@" }),
    (err: Error) => !err.message.includes("secret"),
  );
});

test("loadSettings parses the retry schedule and validates it", () => {
  const base = { PULSE_NOTIFY_CONFIG: "c" };
  const s = loadSettings({
    ...base,
    PULSE_NOTIFY_RETRY_DELAY_MS: "10",
    PULSE_NOTIFY_RETRY_MAX_DELAY_MS: "100",
    PULSE_NOTIFY_RETRY_ATTEMPTS: "0",
  });
  assert.equal(s.retryDelayMs, 10);
  assert.equal(s.retryMaxDelayMs, 100);
  assert.equal(s.retryAttempts, 0);
  assert.throws(() => loadSettings({ ...base, PULSE_NOTIFY_RETRY_ATTEMPTS: "-1" }), StartupError);
  assert.throws(
    () => loadSettings({ ...base, PULSE_NOTIFY_RETRY_MAX_DELAY_MS: "x" }),
    StartupError,
  );
  assert.throws(
    () =>
      loadSettings({
        ...base,
        PULSE_NOTIFY_RETRY_DELAY_MS: "5000",
        PULSE_NOTIFY_RETRY_MAX_DELAY_MS: "100",
      }),
    /at least PULSE_NOTIFY_RETRY_DELAY_MS/,
  );
});

const slack = { id: "s", type: "slack", urlEnv: "SLACK_URL" };
const env = { SLACK_URL: "https://hooks.example.com/T0/secret", PW: "pw-1", SIGN: "key-1" };
const source = {
  env,
  readFile: (path: string): string => {
    if (path === "/run/url") return "https://hooks.example.com/from-file\n";
    if (path === "/run/empty") return "\n";
    throw new Error("ENOENT");
  },
};
const email = {
  id: "m",
  type: "email",
  smtp: { host: "smtp.example.com", port: 587, username: "u", passwordEnv: "PW" },
  from: "pulse@example.com",
  to: ["ops@example.com"],
};

test("new channel types parse and read their secrets from env or file", () => {
  const config = parseConfig(
    {
      channels: [
        { ...slack, statusUrl: "https://status.example.com", hideReason: true },
        { id: "t", type: "teams", urlFile: "/run/url", remindEverySeconds: 60 },
        email,
        { ...hook, secretEnv: "SIGN", excludeChecks: ["x*"] },
      ],
    },
    "cfg.json",
    source,
  );
  const [s, t, m, w] = config.channels;
  assert.equal(s?.type === "slack" && s.url, env.SLACK_URL);
  assert.equal(t?.type === "teams" && t.url, "https://hooks.example.com/from-file");
  assert.equal(t?.remindEverySeconds, 60);
  assert.equal(m?.type === "email" && m.smtp.tls, "starttls");
  assert.equal(m?.type === "email" && m.smtp.password, "pw-1");
  assert.equal(w?.type === "webhook" && w.secret, "key-1");
  assert.deepEqual(w?.excludeChecks, ["x*"]);
});

test("old webhook and file configs parse as before", () => {
  const config = parseConfig({ channels: [hook, file] }, "cfg.json", source);
  assert.deepEqual(config.channels, [hook, file]);
});

test("secret errors name the channel and key, never the value", () => {
  const cases: [unknown, RegExp][] = [
    [{ channels: [{ ...slack, urlEnv: "NOPE" }] }, /channel "s": urlEnv: NOPE is missing or empty/],
    [
      { channels: [{ id: "s", type: "slack", urlFile: "/run/missing" }] },
      /channel "s": urlFile: cannot read file/,
    ],
    [
      { channels: [{ id: "s", type: "slack", urlFile: "/run/empty" }] },
      /urlFile: \/run\/empty is missing or empty/,
    ],
    [{ channels: [{ id: "s", type: "slack" }] }, /urlEnv or urlFile is required/],
    [{ channels: [{ ...slack, urlFile: "/run/url" }] }, /only one of urlEnv and urlFile/],
    [{ channels: [{ ...hook, secretEnv: "NOPE" }] }, /channel "h": secretEnv: NOPE is missing/],
    [{ channels: [{ ...email, smtp: { ...email.smtp, passwordEnv: "NOPE" } }] }, /passwordEnv/],
  ];
  for (const [raw, message] of cases) {
    assert.throws(() => parseConfig(raw, "cfg.json", source), message);
  }
  assert.throws(
    () =>
      parseConfig({ channels: [{ ...slack }] }, "cfg.json", source) &&
      parseConfig({ channels: [{ ...slack, url: env.SLACK_URL }] }, "cfg.json", source),
    /unknown key "url"/,
  );
});

test("slack and teams need https, except on loopback", () => {
  const withUrl = (url: string) => ({
    channels: [{ id: "s", type: "slack", urlEnv: "U" }],
    url,
  });
  const run = (url: string) =>
    parseConfig({ channels: withUrl(url).channels }, "cfg.json", {
      env: { U: url },
      readFile: () => "",
    });
  assert.throws(() => run("http://hooks.example.com/x"), /urlEnv must hold an https url/);
  assert.throws(() => run("not a url"), /does not hold a valid url/);
  assert.doesNotThrow(() => run("https://hooks.example.com/x"));
  assert.doesNotThrow(() => run("http://127.0.0.1:9/x"));
});

test("remindEverySeconds, statusUrl, hideReason and addresses are validated", () => {
  const bad: [unknown, RegExp][] = [
    [{ ...file, remindEverySeconds: 59 }, /remindEverySeconds/],
    [{ ...file, remindEverySeconds: 90.5 }, /remindEverySeconds/],
    [{ ...file, remindEverySeconds: "60" }, /remindEverySeconds/],
    [{ ...slack, statusUrl: "mailto:ops@example.com" }, /statusUrl/],
    [{ ...slack, hideReason: "yes" }, /hideReason/],
    [{ ...hook, hideReason: true }, /unknown key "hideReason"/],
    [{ ...hook, statusUrl: "https://x.example" }, /unknown key "statusUrl"/],
    [{ ...file, excludeChecks: "a" }, /excludeChecks must be an array/],
    [{ ...email, from: "a@b.c\r\nBcc: x@y.z" }, /from must be a single-line/],
    [{ ...email, to: [] }, /non-empty array/],
    [{ ...email, to: ["ok@example.com\nBcc: x@y.z"] }, /to must be a single-line/],
    [{ ...email, to: ["not an address"] }, /email address/],
    [{ ...email, subjectPrefix: "a\nb" }, /subjectPrefix/],
    [{ ...email, smtp: { ...email.smtp, port: 0 } }, /smtp.port/],
    [{ ...email, smtp: { ...email.smtp, tls: "maybe" } }, /smtp.tls/],
    [{ ...email, smtp: { ...email.smtp, extra: 1 } }, /unknown key "extra"/],
    [{ ...email, smtp: { ...email.smtp, tls: "none" } }, /refused with tls "none"/],
    [{ ...email, smtp: { host: "h", port: 25, passwordEnv: "PW" } }, /needs a username/],
  ];
  for (const [channel, message] of bad) {
    assert.throws(() => parseConfig({ channels: [channel] }, "cfg.json", source), message);
  }
});

test("smtp without login and tls none on loopback are allowed", () => {
  const config = parseConfig(
    {
      channels: [
        {
          ...email,
          smtp: { host: "127.0.0.1", port: 25, tls: "none", username: "u", passwordEnv: "PW" },
        },
        { ...email, id: "n", smtp: { host: "smtp.example.com", port: 25 } },
      ],
    },
    "cfg.json",
    source,
  );
  assert.equal(config.channels.length, 2);
});

test("unknown keys in smtp name the path to the object", () => {
  assert.throws(
    () =>
      parseConfig(
        { channels: [{ ...email, smtp: { ...email.smtp, extra: 1 } }] },
        "cfg.json",
        source,
      ),
    (err) =>
      err instanceof ConfigError &&
      err.message === 'cfg.json: unknown key "extra" in channels[0].smtp',
  );
});

test("shape errors name the channel and the key, in the order of the keys", () => {
  const cases: [unknown, string][] = [
    [
      { ...email, smtp: { ...email.smtp, port: 70000 } },
      'channel "m": smtp.port must be an integer from 1 to 65535',
    ],
    [{ ...email, smtp: "x" }, 'channel "m": smtp must be an object'],
    [
      { ...email, smtp: { ...email.smtp, host: "a b" } },
      'channel "m": smtp.host must be a host name',
    ],
    [
      { ...email, smtp: { ...email.smtp, clientName: "bad name" } },
      'channel "m": smtp.clientName must be a host name or an address literal',
    ],
    [{ ...slack, urlEnv: "" }, 'channel "s": urlEnv must be a non-empty string'],
    [{ ...hook, secretFile: 5 }, 'channel "h": secretFile must be a non-empty string'],
  ];
  for (const [channel, message] of cases) {
    assert.throws(
      () => parseConfig({ channels: [channel] }, "cfg.json", source),
      (err) => err instanceof ConfigError && err.message === message,
    );
  }
});

test("error messages never hold the rejected value", () => {
  assert.throws(
    () => parseConfig({ channels: [{ ...hook, url: "user:hunter2@a/b" }] }),
    (err) => err instanceof ConfigError && !err.message.includes("hunter2"),
  );
});

test("every channels example in the docs loads", () => {
  const anySecret = {
    env: new Proxy({}, { get: () => "https://hooks.example.com/x" }),
    readFile: () => "https://hooks.example.com/x\n",
  };
  let loaded = 0;
  for (const name of [
    "README.md",
    ...readdirSync("docs").map((f) => `docs/${f}`),
    ...readdirSync("docs/channels").map((f) => `docs/channels/${f}`),
  ]) {
    if (!name.endsWith(".md")) continue;
    const text = readFileSync(name, "utf8");
    for (const block of text.matchAll(/```json\n([\s\S]*?)```/g)) {
      let json: unknown;
      try {
        json = JSON.parse(block[1] ?? "");
      } catch {
        // A fragment that is not a whole document is not a config example.
        continue;
      }
      if (!isConfigExample(json)) continue;
      assert.doesNotThrow(() => parseConfig(json, name, anySecret), name);
      loaded++;
    }
  }
  assert.ok(loaded > 0);
});

function isConfigExample(json: unknown): boolean {
  return typeof json === "object" && json !== null && "channels" in json;
}

test("retry attempts keep their range and message: no upper bound", () => {
  const base = { PULSE_NOTIFY_CONFIG: "c" };
  assert.equal(
    loadSettings({ ...base, PULSE_NOTIFY_RETRY_ATTEMPTS: "3000000000" }).retryAttempts,
    3_000_000_000,
  );
  assert.throws(() => loadSettings({ ...base, PULSE_NOTIFY_RETRY_ATTEMPTS: "-1" }), {
    message: "PULSE_NOTIFY_RETRY_ATTEMPTS: must be an integer >= 0",
  });
});

test("timer settings and the lock lease have an upper bound; byte limits do not", () => {
  const base = { PULSE_NOTIFY_CONFIG: "c" };
  assert.throws(() => loadSettings({ ...base, PULSE_NOTIFY_POLL_MS: "2592000000" }), {
    message: "PULSE_NOTIFY_POLL_MS: must be an integer from 1 to 2147483647",
  });
  assert.throws(() => loadSettings({ ...base, PULSE_NOTIFY_TIMEOUT_MS: "2147483648" }), {
    message: "PULSE_NOTIFY_TIMEOUT_MS: must be an integer from 1 to 2147483647",
  });
  assert.throws(() => loadSettings({ ...base, PULSE_NOTIFY_LOCK_LEASE_SECONDS: "12884902" }), {
    message: "PULSE_NOTIFY_LOCK_LEASE_SECONDS: must be an integer from 30 to 12884901",
  });
  assert.equal(
    loadSettings({ ...base, PULSE_NOTIFY_LOCK_LEASE_SECONDS: "12884901" }).lockLeaseSeconds,
    12884901,
  );
  assert.equal(
    loadSettings({ ...base, PULSE_NOTIFY_API_MAX_BYTES: "3000000000" }).apiMaxBytes,
    3000000000,
  );
});

const ALERTS_TEXT = 'alerts must be an array of "budget-low", "tls-expiry" or "domain-expiry"';

test("alerts and sendIncidents parse on every channel type, duplicates are ignored", () => {
  const config = parseConfig({
    channels: [
      { ...hook, alerts: ["budget-low", "budget-low", "tls-expiry"], sendIncidents: false },
      { ...file, alerts: [] },
    ],
  });
  assert.deepEqual(config.channels[0]?.alerts, ["budget-low", "tls-expiry"]);
  assert.equal(config.channels[0]?.sendIncidents, false);
  assert.deepEqual(config.channels[1]?.alerts, []);
  assert.equal("sendIncidents" in (config.channels[1] ?? {}), false);
  for (const type of ["slack", "teams", "email"]) {
    const base =
      type === "email"
        ? {
            id: "x",
            type,
            smtp: { host: "localhost", port: 25 },
            from: "a@example.com",
            to: ["b@example.com"],
          }
        : { id: "x", type, urlEnv: "U" };
    const parsed = parseConfig({ channels: [{ ...base, alerts: ["domain-expiry"] }] }, "c", {
      env: { U: "https://hooks.example.com/x" },
      readFile: () => "",
    });
    assert.deepEqual(parsed.channels[0]?.alerts, ["domain-expiry"]);
  }
});

test("alerts and sendIncidents errors are fixed and never echo the value", () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ alerts: "budget-low" }, ALERTS_TEXT],
    [{ alerts: ["secret-value"] }, ALERTS_TEXT],
    [{ alerts: [1] }, ALERTS_TEXT],
    [{ alerts: null }, ALERTS_TEXT],
    [{ sendIncidents: "no" }, "sendIncidents must be true or false"],
    [{ sendIncidents: 0 }, "sendIncidents must be true or false"],
    [{ sendIncidents: false }, "sendIncidents false needs alerts"],
    [{ sendIncidents: false, alerts: [] }, "sendIncidents false needs alerts"],
    [
      { sendIncidents: false, alerts: ["budget-low"], remindEverySeconds: 60 },
      "remindEverySeconds needs sendIncidents",
    ],
  ];
  for (const [extra, text] of cases) {
    assert.throws(
      () => parseConfig({ channels: [{ ...hook, ...extra }] }),
      (err) =>
        err instanceof ConfigError &&
        err.message === `channel "h": ${text}` &&
        !err.message.includes("secret-value"),
    );
  }
});

test("the budget threshold defaults to 25 and accepts 0 and 100", () => {
  assert.equal(loadBudgetThreshold({}), 25);
  assert.equal(loadBudgetThreshold({ PULSE_NOTIFY_BUDGET_THRESHOLD: "0" }), 0);
  assert.equal(loadBudgetThreshold({ PULSE_NOTIFY_BUDGET_THRESHOLD: "100" }), 100);
});

test("the service token comes from env or a file; empty env or file path means unset", () => {
  const files: Record<string, string> = { "/t": " tok-123 \n", "/empty": "\n" };
  const readFile = (p: string): string => {
    const text = files[p];
    if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return text;
  };
  assert.equal(loadSettings({ PULSE_NOTIFY_API_TOKEN: "tok-1" }).apiToken, "tok-1");
  assert.equal(loadSettings({ PULSE_NOTIFY_API_TOKEN_FILE: "/t" }, readFile).apiToken, "tok-123");
  const unset = loadSettings({ PULSE_NOTIFY_CONFIG: "c", PULSE_NOTIFY_API_TOKEN_FILE: "  " });
  assert.equal(unset.apiToken, undefined);
  assert.equal(loadSettings({ PULSE_NOTIFY_API_TOKEN: "t" }).configPath, undefined);
  assert.throws(
    () => loadSettings({ PULSE_NOTIFY_API_TOKEN_FILE: "/empty" }, readFile),
    (err) => err instanceof StartupError && /file is empty/.test(err.message),
  );
  assert.throws(
    () => loadSettings({ PULSE_NOTIFY_API_TOKEN: "tok-1", PULSE_NOTIFY_API_TOKEN_FILE: "/t" }),
    (err) => err instanceof StartupError && !err.message.includes("tok-1"),
  );
});

test("poll settings default to 15000 and 5000 ms with a minimum of 1000", () => {
  const base = { PULSE_NOTIFY_CONFIG: "c" };
  const s = loadSettings({
    ...base,
    PULSE_NOTIFY_CHANNELS_POLL_MS: "1000",
    PULSE_NOTIFY_COMMAND_POLL_MS: "2000",
    PULSE_NOTIFY_SECRET_DIR: "/run/secrets",
  });
  assert.deepEqual([s.channelsPollMs, s.commandPollMs, s.secretDir], [1000, 2000, "/run/secrets"]);
  for (const name of ["PULSE_NOTIFY_CHANNELS_POLL_MS", "PULSE_NOTIFY_COMMAND_POLL_MS"]) {
    assert.throws(() => loadSettings({ ...base, [name]: "999" }), StartupError, name);
  }
});

test("token mode accepts a file without channels; tokenless mode refuses it", () => {
  assert.deepEqual(parseConfig({ channels: [] }, "c", undefined, { allowEmpty: true }), {
    channels: [],
  });
  assert.throws(() => parseConfig({ channels: [] }), /non-empty array/);
});

test("a file webhook takes exactly one of url, urlEnv, urlFile with legacy reference names", () => {
  const source = {
    env: { HOOK_URL: "https://hooks.example.com/a" },
    readFile: (p: string) => (p === "./any/path.txt" ? "http://127.0.0.1:9/b\n" : "x"),
  };
  const env = parseConfig(
    { channels: [{ id: "h", type: "webhook", urlEnv: "HOOK_URL" }] },
    "c",
    source,
  );
  assert.equal(
    env.channels[0]?.type === "webhook" && env.channels[0].url,
    "https://hooks.example.com/a",
  );
  const file = parseConfig(
    { channels: [{ id: "h", type: "webhook", urlFile: "./any/path.txt" }] },
    "c",
    source,
  );
  assert.equal(
    file.channels[0]?.type === "webhook" && file.channels[0].url,
    "http://127.0.0.1:9/b",
  );
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["none", {}, /webhook needs a valid http\(s\) url or one of urlEnv, urlFile/],
    [
      "url and urlEnv",
      { url: "https://a", urlEnv: "HOOK_URL" },
      /exactly one of url, urlEnv, urlFile/,
    ],
    ["urlEnv and urlFile", { urlEnv: "HOOK_URL", urlFile: "./any/path.txt" }, /exactly one/],
    ["not a url", { urlFile: "./other" }, /urlFile does not hold a valid url/],
    ["missing env", { urlEnv: "NOPE" }, /urlEnv: NOPE is missing or empty/],
  ];
  for (const [name, over, message] of cases) {
    assert.throws(
      () => parseConfig({ channels: [{ id: "h", type: "webhook", ...over }] }, "c", source),
      (err) =>
        err instanceof ConfigError &&
        message.test(err.message) &&
        !err.message.includes("hooks.example"),
      name,
    );
  }
});
