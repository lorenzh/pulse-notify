import type { Notification } from "../types.ts";

export const MAX_REASON_LENGTH = 300;

export type MessageState = "DOWN" | "RESOLVED" | "STILL DOWN";

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
}

/** Control characters become spaces; the text is trimmed and cut to `max` characters. */
export function cleanText(value: string, max: number = MAX_REASON_LENGTH): string {
  const text = value.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** "1d 2h", "3h 5m", "12m" or "<1m". */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(Math.max(ms, 0) / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${rest}m`;
  return minutes > 0 ? `${minutes}m` : "<1m";
}

function stateOf(event: Notification["event"]): MessageState {
  switch (event) {
    case "opened":
      return "DOWN";
    case "resolved":
      return "RESOLVED";
    case "reminder":
      return "STILL DOWN";
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

export function messageParts(notification: Notification, opts: MessageOptions): MessageParts {
  const reason = opts.hideReason === true ? "" : cleanText(notification.reason ?? "");
  return {
    name: cleanText(notification.checkName),
    state: stateOf(notification.event),
    reason: reason === "" ? undefined : reason,
    time: notification.time,
    openFor:
      notification.event === "reminder"
        ? formatDuration(notification.timeMs - notification.openedMs)
        : undefined,
    link: opts.statusUrl,
  };
}
