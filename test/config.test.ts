import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, loadConfigFile, loadSettings, parseConfig } from "../src/config.ts";

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
  assert.throws(() => loadSettings({ ...base, PULSE_HEALTH_PORT: "x" }), ConfigError);
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
  });
  assert.equal(loadSettings({ PULSE_NOTIFY_CONFIG: "c", PULSE_NOTIFY_POLL_MS: "10" }).pollMs, 10);
  assert.throws(
    () => loadSettings({ PULSE_NOTIFY_CONFIG: "c", PULSE_NOTIFY_POLL_MS: "abc" }),
    ConfigError,
  );
  assert.throws(
    () => loadSettings({ PULSE_NOTIFY_CONFIG: "c", PULSE_NOTIFY_TIMEOUT_MS: "0" }),
    ConfigError,
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
  assert.throws(() => loadSettings({ ...base, PULSE_NOTIFY_RETRY_ATTEMPTS: "-1" }), ConfigError);
  assert.throws(() => loadSettings({ ...base, PULSE_NOTIFY_RETRY_MAX_DELAY_MS: "x" }), ConfigError);
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
