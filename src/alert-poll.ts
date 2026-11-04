import type { CheckWithState, ComponentWithState } from "@lorenzh/pulse-contract";
import { type AlertLookup, budgetAlerts } from "./budget-alerts.ts";
import { isAlertRouted } from "./channels/routing.ts";
import { expiryAlerts } from "./expiry-alerts.ts";
import type { AlertDelivery, AlertUpsert } from "./ledger.ts";
import type { AlertEvent, ChannelConfig, WarningNotification } from "./types.ts";

/** What one poll read for the alerts; `undefined` means the feed failed or was not read. */
export interface AlertInputs {
  checks: readonly CheckWithState[] | undefined;
  components: readonly ComponentWithState[] | undefined;
}

export interface AlertPlan {
  changes: AlertUpsert[];
  deliveries: AlertDelivery[];
}

/** Whether at least one channel subscribes to `event`. */
export function isSubscribed(channels: readonly ChannelConfig[], event: AlertEvent): boolean {
  return channels.some((c) => (c.alerts ?? []).includes(event));
}

/**
 * Whether a kind may be evaluated: every subscriber has a ledger record. A channel without one
 * is seeded first, or claiming a warning would create its record and skip its incident seeding.
 */
function isGateOpen(
  channels: readonly ChannelConfig[],
  event: AlertEvent,
  hasChannel: (id: string) => boolean,
): boolean {
  const subscribers = channels.filter((c) => (c.alerts ?? []).includes(event));
  return subscribers.length > 0 && subscribers.every((c) => hasChannel(c.id));
}

/**
 * The alert changes of one poll and a delivery per routed channel. Pure: the caller commits the
 * plan in one transaction and enqueues the deliveries only after the commit.
 */
export function planAlerts(
  channels: readonly ChannelConfig[],
  inputs: AlertInputs,
  deps: {
    lookup: AlertLookup;
    hasChannel: (id: string) => boolean;
    threshold: number;
    nowMs: number;
  },
): AlertPlan {
  const { lookup, threshold, nowMs } = deps;
  const notifications: WarningNotification[] = [];
  const changes: AlertUpsert[] = [];
  const add = (evaluation: { notifications: WarningNotification[]; changes: AlertUpsert[] }) => {
    notifications.push(...evaluation.notifications);
    changes.push(...evaluation.changes);
  };
  if (isGateOpen(channels, "budget-low", deps.hasChannel)) {
    if (inputs.checks) add(budgetAlerts("check", inputs.checks, lookup, threshold, nowMs));
    if (inputs.components) {
      add(budgetAlerts("component", inputs.components, lookup, threshold, nowMs));
    }
  }
  const kinds = {
    tls: isGateOpen(channels, "tls-expiry", deps.hasChannel),
    domain: isGateOpen(channels, "domain-expiry", deps.hasChannel),
  };
  if (inputs.checks && (kinds.tls || kinds.domain)) {
    add(expiryAlerts(inputs.checks, lookup, kinds, nowMs));
  }
  const deliveries: AlertDelivery[] = [];
  for (const notification of notifications) {
    for (const channel of channels) {
      if (!isAlertRouted(channel, notification.event, notification.subject)) continue;
      deliveries.push({ channelId: channel.id, key: notification.key, notification });
    }
  }
  return { changes, deliveries };
}
