import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogger } from "../src/log.ts";
import { Metrics } from "../src/metrics.ts";

test("metrics render counters per channel and escape labels", () => {
  let pending = 2;
  const metrics = new Metrics(['we"ird', "log"], () => pending);
  metrics.pollDone("ok");
  metrics.pollDone("ok");
  metrics.pollDone("error");
  metrics.deliveryDone("log", "success");
  metrics.deliveryDone('we"ird', "failure");
  pending = 1;
  const text = metrics.render();
  assert.match(text, /pulse_notify_polls_total\{outcome="ok"\} 2/);
  assert.match(text, /pulse_notify_polls_total\{outcome="error"\} 1/);
  assert.match(text, /deliveries_total\{channel="log",outcome="success"\} 1/);
  assert.match(text, /deliveries_total\{channel="we\\"ird",outcome="failure"\} 1/);
  assert.match(text, /pulse_notify_pending_deliveries 1\n/);
});

test("logger drops lines below the level and writes ISO time", () => {
  const lines: string[] = [];
  const log = createLogger(
    (l) => lines.push(l),
    () => 0,
    "warn",
  );
  log.log("info", "quiet");
  log.log("error", "loud", { a: 1 });
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0] ?? ""), {
    time: "1970-01-01T00:00:00.000Z",
    level: "error",
    msg: "loud",
    a: 1,
  });
});
