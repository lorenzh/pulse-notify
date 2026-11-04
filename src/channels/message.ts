import { formatDuration } from "@lorenzh/pulse-kit";
import {
  type BudgetNotification,
  type ExpiryNotification,
  type IncidentNotification,
  isIncidentNotification,
  type Notification,
  type WarningNotification,
} from "../types.ts";

export const MAX_REASON_LENGTH = 300;

export type MessageState =
  | "DOWN"
  | "RESOLVED"
  | "STILL DOWN"
  | "INCIDENT"
  | "UPDATE"
  | "BUDGET LOW"
  | "TLS EXPIRES SOON"
  | "DOMAIN EXPIRES SOON";

export const MAX_MANUAL_MESSAGE_LENGTH = 1000;

export interface MessageOptions {
  hideReason?: boolean | undefined;
  statusUrl?: string | undefined;
}

/** The parts of a chat or email message. Text fields are already cleaned. */
export interface MessageParts {
  name: string;
  state: MessageState;
  reason: string | undefined;
  time: string;
  /** How long the incident has been open; set for reminders only. */
  openFor: string | undefined;
  link: string | undefined;
  /** Set for a manual incident. Text is cleaned. */
  manual: { impact: string; status: string; message: string; components: string } | undefined;
  /** Set for a warning: the subject kind and the fixed detail lines. */
  warning: WarningParts | undefined;
}

/** One detail line of a warning; the value is built from numbers and fixed text only. */
export interface WarningFact {
  title: string;
  value: string;
}

export interface WarningParts {
  subjectKind: "Check" | "Component";
  facts: WarningFact[];
}

/** Control characters become spaces; the text is trimmed and cut to `max` characters. */
export function cleanText(value: string, max: number = MAX_REASON_LENGTH): string {
  const text = value.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function stateOf(notification: IncidentNotification): MessageState {
  const isManual = notification.manual !== undefined;
  switch (notification.event) {
    case "opened":
      return isManual ? "INCIDENT" : "DOWN";
    case "update":
      return "UPDATE";
    case "resolved":
      return "RESOLVED";
    case "reminder":
      return "STILL DOWN";
    default: {
      const unreachable: never = notification.event;
      return unreachable;
    }
  }
}

/** Rounds toward negative infinity to `digits` decimals, for display only. */
function floorTo(value: number, digits: number): string {
  const scale = 10 ** digits;
  return (Math.floor(value * scale) / scale).toFixed(digits);
}

function budgetFacts(n: BudgetNotification): WarningFact[] {
  const { remaining, threshold, target, availability, windowDays } = n.budget;
  const measured = availability === null ? "no data" : `${floorTo(availability, 3)}%`;
  return [
    { title: "Error budget left", value: `${floorTo(remaining, 1)}% (alert below ${threshold}%)` },
    { title: "Availability", value: `${measured} (target ${target}%, ${windowDays} days)` },
  ];
}

function daysText(days: number): string {
  if (days === 0) return "less than 1 day";
  return days === 1 ? "1 day" : `${days} days`;
}

function expiryFacts(n: ExpiryNotification): WarningFact[] {
  const kind = n.event === "tls-expiry" ? "TLS certificate" : "domain registration";
  return [
    { title: "Expires in", value: daysText(n.expiry.daysLeft) },
    { title: "Kind", value: kind },
  ];
}

function warningState(n: WarningNotification): MessageState {
  switch (n.event) {
    case "budget-low":
      return "BUDGET LOW";
    case "tls-expiry":
      return "TLS EXPIRES SOON";
    case "domain-expiry":
      return "DOMAIN EXPIRES SOON";
    default: {
      const unreachable: never = n;
      return unreachable;
    }
  }
}

/** `hideReason` does not apply: a warning has no reason. */
function warningParts(n: WarningNotification, opts: MessageOptions): MessageParts {
  return {
    name: cleanText(n.subject.name),
    state: warningState(n),
    reason: undefined,
    time: n.time,
    openFor: undefined,
    link: opts.statusUrl,
    manual: undefined,
    warning: {
      subjectKind: n.subject.kind === "check" ? "Check" : "Component",
      facts: n.event === "budget-low" ? budgetFacts(n) : expiryFacts(n),
    },
  };
}

export function messageParts(notification: Notification, opts: MessageOptions): MessageParts {
  if (!isIncidentNotification(notification)) return warningParts(notification, opts);
  const reason = opts.hideReason === true ? "" : cleanText(notification.reason ?? "");
  return {
    name: cleanText(notification.checkName),
    state: stateOf(notification),
    reason: reason === "" ? undefined : reason,
    time: notification.time,
    openFor:
      notification.event === "reminder"
        ? formatDuration(notification.timeMs - notification.openedMs)
        : undefined,
    link: opts.statusUrl,
    manual: notification.manual && {
      impact: cleanText(notification.manual.impact, 40),
      status: cleanText(notification.manual.status, 40),
      message: cleanText(notification.manual.message, MAX_MANUAL_MESSAGE_LENGTH),
      components: cleanText(notification.manual.componentIds.join(", "), MAX_REASON_LENGTH),
    },
    warning: undefined,
  };
}
