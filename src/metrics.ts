import { type Counter, createRegistry, type Gauge } from "@lorenzh/pulse-kit";

export type PollOutcome = "ok" | "error";
export type DeliveryOutcome = "success" | "failure";

const POLL_OUTCOMES: readonly PollOutcome[] = ["ok", "error"];
const DELIVERY_OUTCOMES: readonly DeliveryOutcome[] = ["success", "failure"];

/** Counters for `/metrics`. They live in memory and reset on restart. */
export class Metrics {
  readonly #registry = createRegistry();
  readonly #polls: Counter;
  readonly #deliveries: Counter;

  /** Only channel ids are used as labels: never a URL or a path. */
  constructor(channelIds: string[], pending: () => number, failedPolls: () => number = () => 0) {
    const up = this.#registry.gauge("pulse_up", "Whether the process runs.");
    this.#polls = this.#registry.counter("pulse_notify_polls_total", "API polls by outcome.");
    this.#deliveries = this.#registry.counter(
      "pulse_notify_deliveries_total",
      "Finished deliveries by channel and outcome.",
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
    for (const channel of channelIds) {
      for (const outcome of DELIVERY_OUTCOMES) this.#deliveries.inc({ channel, outcome }, 0);
    }
    this.#registry.collect(() => {
      pendingGauge.set(pending());
      failedGauge.set(failedPolls());
    });
  }

  pollDone(outcome: PollOutcome): void {
    this.#polls.inc({ outcome });
  }

  deliveryDone(channel: string, outcome: DeliveryOutcome): void {
    this.#deliveries.inc({ channel, outcome });
  }

  /** Prometheus text format, version 0.0.4. */
  render(): string {
    return this.#registry.render();
  }
}
