import { test } from "bun:test";
import assert from "node:assert/strict";
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

test("metrics keep the names, help texts and order", () => {
  const text = new Metrics(["log"], () => 0).render();
  assert.equal(
    text,
    [
      "# HELP pulse_up Whether the process runs.",
      "# TYPE pulse_up gauge",
      "pulse_up 1",
      "# HELP pulse_notify_polls_total API polls by outcome.",
      "# TYPE pulse_notify_polls_total counter",
      'pulse_notify_polls_total{outcome="ok"} 0',
      'pulse_notify_polls_total{outcome="error"} 0',
      "# HELP pulse_notify_feed_polls_total API feed reads by feed and outcome.",
      "# TYPE pulse_notify_feed_polls_total counter",
      'pulse_notify_feed_polls_total{feed="incidents",outcome="ok"} 0',
      'pulse_notify_feed_polls_total{feed="incidents",outcome="error"} 0',
      'pulse_notify_feed_polls_total{feed="checks",outcome="ok"} 0',
      'pulse_notify_feed_polls_total{feed="checks",outcome="error"} 0',
      'pulse_notify_feed_polls_total{feed="manual-incidents",outcome="ok"} 0',
      'pulse_notify_feed_polls_total{feed="manual-incidents",outcome="error"} 0',
      "# HELP pulse_notify_deliveries_total Finished deliveries by channel and outcome.",
      "# TYPE pulse_notify_deliveries_total counter",
      'pulse_notify_deliveries_total{channel="log",outcome="success"} 0',
      'pulse_notify_deliveries_total{channel="log",outcome="failure"} 0',
      "# HELP pulse_notify_skipped_items_total API feed items skipped as malformed, by feed.",
      "# TYPE pulse_notify_skipped_items_total counter",
      'pulse_notify_skipped_items_total{feed="incidents"} 0',
      'pulse_notify_skipped_items_total{feed="checks"} 0',
      'pulse_notify_skipped_items_total{feed="manual-incidents"} 0',
      "# HELP pulse_notify_pending_deliveries Notifications not yet delivered or failed.",
      "# TYPE pulse_notify_pending_deliveries gauge",
      "pulse_notify_pending_deliveries 0",
      "# HELP pulse_notify_consecutive_failed_polls Polls in a row that failed; 0 after a good poll.",
      "# TYPE pulse_notify_consecutive_failed_polls gauge",
      "pulse_notify_consecutive_failed_polls 0",
      "",
    ].join("\n"),
  );
});

test("feed reads count per feed and outcome; poll outcomes are counted apart", () => {
  const metrics = new Metrics(["log"], () => 0);
  metrics.feedPollDone("checks", "error");
  metrics.feedPollDone("checks", "error");
  metrics.feedPollDone("incidents", "ok");
  metrics.pollDone("ok");
  const text = metrics.render();
  assert.match(text, /pulse_notify_feed_polls_total\{feed="checks",outcome="error"\} 2\n/);
  assert.match(text, /pulse_notify_feed_polls_total\{feed="incidents",outcome="ok"\} 1\n/);
  assert.match(text, /pulse_notify_feed_polls_total\{feed="manual-incidents",outcome="ok"\} 0\n/);
  assert.match(text, /^pulse_notify_polls_total\{outcome="ok"\} 1$/m);
});

test("skipped items count per feed", () => {
  const metrics = new Metrics([], () => 0);
  metrics.itemSkipped("checks");
  metrics.itemSkipped("checks");
  const text = metrics.render();
  assert.match(text, /^pulse_notify_skipped_items_total\{feed="checks"\} 2$/m);
  assert.match(text, /^pulse_notify_skipped_items_total\{feed="incidents"\} 0$/m);
});
