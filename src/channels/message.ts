import { formatDuration } from "@lorenzh/pulse-kit";
import type { Notification } from "../types.ts";

export const MAX_REASON_LENGTH = 300;

export type MessageState = "DOWN" | "RESOLVED" | "STILL DOWN" | "INCIDENT" | "UPDATE";

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
}

/** Control characters become spaces; the text is trimmed and cut to `max` characters. */
export function cleanText(value: string, max: number = MAX_REASON_LENGTH): string {
  const text = value.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function stateOf(notification: Notification): MessageState {
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

export function messageParts(notification: Notification, opts: MessageOptions): MessageParts {
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
  };
}
