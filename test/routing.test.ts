import { test } from "bun:test";
import assert from "node:assert/strict";
import { isAlertRouted, isRouted } from "../src/channels/routing.ts";
import type { ChannelConfig } from "../src/types.ts";

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

test("warnings go only to channels that subscribe to the kind and route the subject", () => {
  const check = (id: string) => ({ kind: "check" as const, id });
  const component = (id: string) => ({ kind: "component" as const, id });
  const apiOnly = { alerts: ["budget-low" as const], checks: ["api-*"] };
  const warningOnly: ChannelConfig = {
    id: "w",
    type: "file",
    path: "/dev/null",
    alerts: ["domain-expiry"],
    sendIncidents: false,
  };
  const cases: [string, Parameters<typeof isAlertRouted>, boolean][] = [
    ["check api-1 matches checks", [apiOnly, "budget-low", check("api-1")], true],
    ["check web-1 does not match", [apiOnly, "budget-low", check("web-1")], false],
    ["component ignores check filters", [apiOnly, "budget-low", component("web")], true],
    [
      "component exclusion wins",
      [
        { alerts: ["budget-low"], components: ["web"], excludeComponents: ["web"] },
        "budget-low",
        component("web"),
      ],
      false,
    ],
    [
      "component include list",
      [{ alerts: ["budget-low"], components: ["db"] }, "budget-low", component("web")],
      false,
    ],
    [
      "component is not expanded to member checks",
      [{ alerts: ["budget-low"], components: ["web"] }, "budget-low", check("web")],
      true,
    ],
    [
      "check exclusion wins",
      [{ alerts: ["tls-expiry"], excludeChecks: ["x*"] }, "tls-expiry", check("x1")],
      false,
    ],
    [
      "tls only gets no domain warning",
      [{ alerts: ["tls-expiry"] }, "domain-expiry", check("d")],
      false,
    ],
    ["no alerts gets no warning", [{}, "budget-low", check("a")], false],
    ["empty alerts gets no warning", [{ alerts: [] }, "budget-low", check("a")], false],
    [
      "sendIncidents false does not block warnings",
      [warningOnly, "domain-expiry", check("d")],
      true,
    ],
  ];
  for (const [name, args, expected] of cases) {
    assert.equal(isAlertRouted(...args), expected, name);
  }
});
