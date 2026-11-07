import { type Counter, createRegistry, type Gauge } from "@lorenzh/pulse-kit";

export type PollOutcome = "ok" | "error";
export type DeliveryOutcome = "success" | "failure";
/** The api paths that notify reads; `components` only with a budget-low subscription. */
export type FeedName = "incidents" | "checks" | "manual-incidents" | "components";

const FEED_NAMES: readonly FeedName[] = ["incidents", "checks", "manual-incidents", "components"];

const POLL_OUTCOMES: readonly PollOutcome[] = ["ok", "error"];
const DELIVERY_OUTCOMES: readonly DeliveryOutcome[] = ["success", "failure"];

/** Counters for `/metrics`. They live in memory and reset on restart. */
export class Metrics {
  readonly #registry = createRegistry();
  readonly #polls: Counter;
  readonly #feedPolls: Counter;
  readonly #deliveries: Counter;
  readonly #skipped: Counter;

  /** Only channel ids are used as labels: never a URL or a path. */
  constructor(channelIds: string[], pending: () => number, failedPolls: () => number = () => 0) {
    const up = this.#registry.gauge("pulse_up", "Whether the process runs.");
    this.#polls = this.#registry.counter("pulse_notify_polls_total", "API polls by outcome.");
    this.#feedPolls = this.#registry.counter(
      "pulse_notify_feed_polls_total",
      "API feed reads by feed and outcome.",
    );
    this.#deliveries = this.#registry.counter(
      "pulse_notify_deliveries_total",
      "Finished deliveries by channel and outcome.",
    );
    this.#skipped = this.#registry.counter(
      "pulse_notify_skipped_items_total",
      "API feed items skipped as malformed, by feed.",
    );
    const pendingGauge: Gauge = this.#registry.gauge(
      "pulse_notify_pending_deliveries",
      "Notifications not yet delivered or failed.",
    );
    const failedGauge: Gauge = this.#registry.gauge(
      "pulse_notify_consecutive_failed_polls",
      "Polls in a row that failed; 0 after a good poll.",
    );
    up.set(1);
    // Every series exists from the start, so a scrape before the first event shows zeros.
    for (const outcome of POLL_OUTCOMES) this.#polls.inc({ outcome }, 0);
    for (const feed of FEED_NAMES) {
      for (const outcome of POLL_OUTCOMES) this.#feedPolls.inc({ feed, outcome }, 0);
      this.#skipped.inc({ feed }, 0);
    }
    for (const channel of channelIds) this.installChannel(channel);
    this.#registry.collect(() => {
      pendingGauge.set(pending());
      failedGauge.set(failedPolls());
    });
  }

  /** Creates the delivery series of a channel at zero; a second call changes nothing. */
  installChannel(channel: string): void {
    for (const outcome of DELIVERY_OUTCOMES) this.#deliveries.inc({ channel, outcome }, 0);
  }

  pollDone(outcome: PollOutcome): void {
    this.#polls.inc({ outcome });
  }

  feedPollDone(feed: FeedName, outcome: PollOutcome): void {
    this.#feedPolls.inc({ feed, outcome });
  }

  itemSkipped(feed: FeedName): void {
    this.#skipped.inc({ feed });
  }

  deliveryDone(channel: string, outcome: DeliveryOutcome): void {
    this.#deliveries.inc({ channel, outcome });
  }

  /**
   * Registers the subscription series of R7. Called only when subscriptions are on, so with
   * them off `/metrics` stays as it was. The reads run at scrape.
   */
  enableSubscriptions(reads: SubscriptionReads): SubscriptionMetrics {
    return createSubscriptionMetrics(this.#registry, reads);
  }

  /** Prometheus text format, version 0.0.4. */
  render(): string {
    return this.#registry.render();
  }
}

export type SubscriptionRoute = "subscribe" | "confirm" | "unsubscribe";
export type SubscriptionRequestOutcome =
  | "queued"
  | "known"
  | "limited"
  | "ok"
  | "invalid"
  | "unauthorized"
  | "error";
export type SubscriberMailKind = "confirmation" | "incident";
export type SubscriptionLimitLabel = "capacity" | "pending" | "window" | "queue";

/** Values read at scrape; a store read that throws leaves the last value. */
export interface SubscriptionReads {
  subscribers: () => { pending: number; confirmed: number };
  eventsPending: () => number;
  confirmationsQueued: () => number;
}

export interface SubscriptionMetrics {
  requestDone: (route: SubscriptionRoute, outcome: SubscriptionRequestOutcome) => void;
  limited: (limit: SubscriptionLimitLabel) => void;
  mailDone: (kind: SubscriberMailKind, outcome: DeliveryOutcome) => void;
  detectionDone: () => void;
}

const ROUTE_OUTCOMES: Record<SubscriptionRoute, readonly SubscriptionRequestOutcome[]> = {
  subscribe: ["queued", "known", "limited", "invalid", "unauthorized", "error"],
  confirm: ["ok", "invalid", "unauthorized", "error"],
  unsubscribe: ["ok", "invalid", "unauthorized", "error"],
};
const LIMITS: readonly SubscriptionLimitLabel[] = ["capacity", "pending", "window", "queue"];
const MAIL_KINDS: readonly SubscriberMailKind[] = ["confirmation", "incident"];

function createSubscriptionMetrics(
  registry: ReturnType<typeof createRegistry>,
  reads: SubscriptionReads,
): SubscriptionMetrics {
  const subscribers = registry.gauge("pulse_notify_subscribers", "Subscriber rows by state.");
  const eventsPending = registry.gauge(
    "pulse_notify_subscriber_events_pending",
    "Incident events whose subscriber fan-out is not finished.",
  );
  const detections = registry.counter(
    "pulse_notify_subscriber_detections_total",
    "Polls whose manual incident read was stored for subscribers.",
  );
  const mails = registry.counter(
    "pulse_notify_subscriber_mails_total",
    "Subscriber mails by kind and final outcome.",
  );
  const queued = registry.gauge(
    "pulse_notify_subscriber_confirmations_queued",
    "Confirmation mails queued or in flight.",
  );
  const requests = registry.counter(
    "pulse_notify_subscription_requests_total",
    "Subscription listener requests by route and outcome.",
  );
  const limited = registry.counter(
    "pulse_notify_subscription_limited_total",
    "Subscribe requests refused silently, by the first limit that applied.",
  );
  for (const state of ["pending", "confirmed"]) subscribers.set(0, { state });
  eventsPending.set(0);
  detections.inc({}, 0);
  for (const kind of MAIL_KINDS) {
    for (const outcome of DELIVERY_OUTCOMES) mails.inc({ kind, outcome }, 0);
  }
  queued.set(0);
  for (const [route, outcomes] of Object.entries(ROUTE_OUTCOMES)) {
    for (const outcome of outcomes) requests.inc({ route, outcome }, 0);
  }
  for (const limit of LIMITS) limited.inc({ limit }, 0);
  registry.collect(() => {
    queued.set(reads.confirmationsQueued());
    try {
      const counts = reads.subscribers();
      subscribers.set(counts.pending, { state: "pending" });
      subscribers.set(counts.confirmed, { state: "confirmed" });
      eventsPending.set(reads.eventsPending());
    } catch {
      // A closed or failing store keeps the last values; the scrape itself must not fail.
    }
  });
  return {
    requestDone: (route, outcome) => requests.inc({ route, outcome }),
    limited: (limit) => limited.inc({ limit }),
    mailDone: (kind, outcome) => mails.inc({ kind, outcome }),
    detectionDone: () => detections.inc(),
  };
}
