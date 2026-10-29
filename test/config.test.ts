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
  ["unknown type", { channels: [{ id: "x", type: "email" }] }, /unknown type "email"/],
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
