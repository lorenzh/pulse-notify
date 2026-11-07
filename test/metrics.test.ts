import { test } from "bun:test";
import assert from "node:assert/strict";
import { Metrics } from "../src/metrics.ts";
import { letLoopRun, subscriptionFixture } from "./subscriptions-support.ts";

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
      'pulse_notify_feed_polls_total{feed="components",outcome="ok"} 0',
      'pulse_notify_feed_polls_total{feed="components",outcome="error"} 0',
      "# HELP pulse_notify_deliveries_total Finished deliveries by channel and outcome.",
      "# TYPE pulse_notify_deliveries_total counter",
      'pulse_notify_deliveries_total{channel="log",outcome="success"} 0',
      'pulse_notify_deliveries_total{channel="log",outcome="failure"} 0',
      "# HELP pulse_notify_skipped_items_total API feed items skipped as malformed, by feed.",
      "# TYPE pulse_notify_skipped_items_total counter",
      'pulse_notify_skipped_items_total{feed="incidents"} 0',
      'pulse_notify_skipped_items_total{feed="checks"} 0',
      'pulse_notify_skipped_items_total{feed="manual-incidents"} 0',
      'pulse_notify_skipped_items_total{feed="components"} 0',
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

test("subscription series render with names, help texts and labels when on", () => {
  const metrics = new Metrics(["log"], () => 0);
  const subs = metrics.enableSubscriptions({
    subscribers: () => ({ pending: 3, confirmed: 7 }),
    eventsPending: () => 1,
    confirmationsQueued: () => 2,
  });
  subs.limited("capacity");
  subs.limited("capacity");
  subs.requestDone("subscribe", "queued");
  subs.mailDone("confirmation", "success");
  subs.detectionDone();
  const text = metrics.render();
  for (const line of [
    "# HELP pulse_notify_subscribers Subscriber rows by state.",
    "# TYPE pulse_notify_subscribers gauge",
    'pulse_notify_subscribers{state="pending"} 3',
    'pulse_notify_subscribers{state="confirmed"} 7',
    "# HELP pulse_notify_subscriber_events_pending Incident events whose subscriber fan-out is not finished.",
    "pulse_notify_subscriber_events_pending 1",
    "# TYPE pulse_notify_subscriber_detections_total counter",
    "pulse_notify_subscriber_detections_total 1",
    'pulse_notify_subscriber_mails_total{kind="confirmation",outcome="success"} 1',
    'pulse_notify_subscriber_mails_total{kind="incident",outcome="failure"} 0',
    "# HELP pulse_notify_subscriber_confirmations_queued Confirmation mails queued or in flight.",
    "pulse_notify_subscriber_confirmations_queued 2",
    'pulse_notify_subscription_requests_total{route="subscribe",outcome="queued"} 1',
    'pulse_notify_subscription_requests_total{route="confirm",outcome="ok"} 0',
    'pulse_notify_subscription_requests_total{route="unsubscribe",outcome="unauthorized"} 0',
    'pulse_notify_subscription_limited_total{limit="capacity"} 2',
    'pulse_notify_subscription_limited_total{limit="queue"} 0',
  ]) {
    assert.ok(text.split("\n").includes(line), line);
  }
});

test("a held confirmation gives gauge 1; success grows by 1 before the gauge is 0", async () => {
  const f = subscriptionFixture();
  const metrics = new Metrics([], () => 0);
  const subs = metrics.enableSubscriptions({
    subscribers: () => ({ pending: 0, confirmed: 0 }),
    eventsPending: () => 0,
    confirmationsQueued: () => f.worker.size(),
  });
  const seen: string[] = [];
  const line = (text: string, name: string): string =>
    text.split("\n").find((l) => l.startsWith(name)) ?? "";
  try {
    f.outcomes.push = (o: string): number => {
      subs.mailDone("confirmation", o === "success" ? "success" : "failure");
      seen.push(line(metrics.render(), "pulse_notify_subscriber_confirmations_queued "));
      return 0;
    };
    f.ops.subscribe("a@example.com", 0);
    await letLoopRun();
    assert.equal(
      line(metrics.render(), "pulse_notify_subscriber_confirmations_queued "),
      "pulse_notify_subscriber_confirmations_queued 1",
    );
    f.mailer.calls[0]?.resolve();
    await letLoopRun();
    assert.deepEqual(seen, ["pulse_notify_subscriber_confirmations_queued 1"]);
    const text = metrics.render();
    assert.ok(
      text.includes(
        'pulse_notify_subscriber_mails_total{kind="confirmation",outcome="success"} 1\n',
      ),
    );
    assert.ok(text.includes("pulse_notify_subscriber_confirmations_queued 0\n"));
  } finally {
    await f.close();
  }
});

test("a store read that fails at scrape keeps the scrape working", () => {
  const metrics = new Metrics([], () => 0);
  metrics.enableSubscriptions({
    subscribers: () => {
      throw new Error("closed");
    },
    eventsPending: () => 0,
    confirmationsQueued: () => 0,
  });
  assert.ok(metrics.render().includes('pulse_notify_subscribers{state="pending"} 0'));
});
