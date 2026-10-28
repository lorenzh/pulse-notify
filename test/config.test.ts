import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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
    timeoutMs: 5000,
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
