import assert from "node:assert/strict";
import { test } from "node:test";
import { isRouted } from "../src/channels/routing.ts";

test("no lists route every check", () => {
  assert.equal(isRouted({}, "a"), true);
  assert.equal(isRouted({ checks: [] }, "a"), true);
});

test("an entry without a star matches exactly", () => {
  assert.equal(isRouted({ checks: ["api"] }, "api"), true);
  assert.equal(isRouted({ checks: ["api"] }, "api-2"), false);
  assert.equal(isRouted({ checks: ["a.b"] }, "aXb"), false);
});

test("a star matches any characters", () => {
  const channel = { checks: ["api-*", "*-db", "x*y"] };
  assert.equal(isRouted(channel, "api-eu"), true);
  assert.equal(isRouted(channel, "main-db"), true);
  assert.equal(isRouted(channel, "xy"), true);
  assert.equal(isRouted(channel, "xzzy"), true);
  assert.equal(isRouted(channel, "other"), false);
  assert.equal(isRouted({ checks: ["*"] }, "anything"), true);
});

test("excludeChecks wins over checks", () => {
  const channel = { checks: ["api-*"], excludeChecks: ["api-staging", "*-test"] };
  assert.equal(isRouted(channel, "api-eu"), true);
  assert.equal(isRouted(channel, "api-staging"), false);
  assert.equal(isRouted(channel, "api-test"), false);
  assert.equal(isRouted({ excludeChecks: ["x"] }, "y"), true);
});
