export type NotificationEvent = "opened" | "resolved" | "reminder";

export interface Notification {
  key: string;
  event: NotificationEvent;
  incidentId: number;
  checkId: string;
  checkName: string;
  reason: string | null;
  /** ISO 8601 UTC of the event time (openedAt, resolvedAt, or the send time of a reminder). */
  time: string;
  timeMs: number;
  /** Epoch milliseconds when the incident opened; the age of a reminder is `timeMs - openedMs`. */
  openedMs: number;
}

interface ChannelBase {
  id: string;
  /** Check ids or `*` globs to notify about; absent or empty means all checks. */
  checks?: string[];
  /** Check ids or `*` globs to skip. Wins over `checks`. */
  excludeChecks?: string[];
  /** Seconds between "still down" reminders for an open incident; absent means none. */
  remindEverySeconds?: number;
}

export interface WebhookChannelConfig extends ChannelBase {
  type: "webhook";
  url: string;
  /** Signing secret, read at startup from the environment or a file. */
  secret?: string;
}

export interface FileChannelConfig extends ChannelBase {
  type: "file";
  path: string;
}

interface ChatChannelBase extends ChannelBase {
  /** Incoming webhook URL, read at startup from the environment or a file. */
  url: string;
  /** Link to the status page; the message shows it when set. */
  statusUrl?: string;
  hideReason?: boolean;
}

export interface SlackChannelConfig extends ChatChannelBase {
  type: "slack";
}

export interface TeamsChannelConfig extends ChatChannelBase {
  type: "teams";
}

export interface SmtpConfig {
  host: string;
  port: number;
  tls: "starttls" | "tls" | "none";
  username?: string;
  /** Read at startup from the environment or a file. */
  password?: string;
}

export interface EmailChannelConfig extends ChannelBase {
  type: "email";
  smtp: SmtpConfig;
  from: string;
  to: string[];
  subjectPrefix?: string;
  statusUrl?: string;
  hideReason?: boolean;
}

export type ChannelConfig =
  | WebhookChannelConfig
  | FileChannelConfig
  | SlackChannelConfig
  | TeamsChannelConfig
  | EmailChannelConfig;

export interface Config {
  channels: ChannelConfig[];
}

/** Sends one notification; rejects on failure. */
export type Sender = (notification: Notification, signal?: AbortSignal) => Promise<void>;

/** Resolves after `ms`, or early when `signal` aborts. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** Starts a timer and returns a function that cancels it. */
export type Schedule = (fn: () => void, ms: number) => () => void;
