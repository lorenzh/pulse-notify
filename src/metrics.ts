export type PollOutcome = "ok" | "error";
export type DeliveryOutcome = "success" | "failure";

const POLL_OUTCOMES: readonly PollOutcome[] = ["ok", "error"];
const DELIVERY_OUTCOMES: readonly DeliveryOutcome[] = ["success", "failure"];

/** Counters for `/metrics`. They live in memory and reset on restart. */
export class Metrics {
  readonly #polls = new Map<PollOutcome, number>();
  readonly #deliveries = new Map<string, number>();
  readonly #channelIds: string[];
  readonly #pending: () => number;

  /** Only channel ids are used as labels: never a URL or a path. */
  constructor(channelIds: string[], pending: () => number) {
    this.#channelIds = channelIds;
    this.#pending = pending;
  }

  pollDone(outcome: PollOutcome): void {
    this.#polls.set(outcome, (this.#polls.get(outcome) ?? 0) + 1);
  }

  deliveryDone(channel: string, outcome: DeliveryOutcome): void {
    const key = `${channel}\u0000${outcome}`;
    this.#deliveries.set(key, (this.#deliveries.get(key) ?? 0) + 1);
  }

  /** Prometheus text format, version 0.0.4. */
  render(): string {
    const lines = [
      "# HELP pulse_up Whether the process runs.",
      "# TYPE pulse_up gauge",
      "pulse_up 1",
      "# HELP pulse_notify_polls_total API polls by outcome.",
      "# TYPE pulse_notify_polls_total counter",
    ];
    for (const outcome of POLL_OUTCOMES) {
      lines.push(`pulse_notify_polls_total{outcome="${outcome}"} ${this.#polls.get(outcome) ?? 0}`);
    }
    lines.push(
      "# HELP pulse_notify_deliveries_total Finished deliveries by channel and outcome.",
      "# TYPE pulse_notify_deliveries_total counter",
    );
    for (const channel of this.#channelIds) {
      for (const outcome of DELIVERY_OUTCOMES) {
        const count = this.#deliveries.get(`${channel}\u0000${outcome}`) ?? 0;
        lines.push(
          `pulse_notify_deliveries_total{channel="${escapeLabel(channel)}",outcome="${outcome}"} ${count}`,
        );
      }
    }
    lines.push(
      "# HELP pulse_notify_pending_deliveries Notifications not yet delivered or failed.",
      "# TYPE pulse_notify_pending_deliveries gauge",
      `pulse_notify_pending_deliveries ${this.#pending()}`,
    );
    return `${lines.join("\n")}\n`;
  }
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}
