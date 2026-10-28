export type NotificationEvent = "opened" | "resolved";

export interface Notification {
  key: string;
  event: NotificationEvent;
  incidentId: number;
  checkId: string;
  checkName: string;
  reason: string | null;
  /** ISO 8601 UTC of the event time (openedAt or resolvedAt). */
  time: string;
  timeMs: number;
}

interface ChannelBase {
  id: string;
  /** Check ids to notify about; absent or empty means all checks. */
  checks?: string[];
}

export interface WebhookChannelConfig extends ChannelBase {
  type: "webhook";
  url: string;
}

export interface FileChannelConfig extends ChannelBase {
  type: "file";
  path: string;
}

export type ChannelConfig = WebhookChannelConfig | FileChannelConfig;

export interface Config {
  channels: ChannelConfig[];
}

/** Sends one notification; rejects on failure. */
export type Sender = (notification: Notification) => Promise<void>;

export type Sleep = (ms: number) => Promise<void>;

/** Starts a timer and returns a function that cancels it. */
export type Schedule = (fn: () => void, ms: number) => () => void;
