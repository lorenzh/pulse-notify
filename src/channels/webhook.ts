import type { Sender, WebhookChannelConfig } from "../types.ts";
import { type HttpDeps, postJson } from "./http-post.ts";
import { signBody } from "./signature.ts";

export interface WebhookOptions extends HttpDeps {
  /** Clock for `X-Pulse-Timestamp`. */
  now?: (() => number) | undefined;
}

export function createWebhookSender(
  channel: WebhookChannelConfig,
  opts: WebhookOptions = {},
): Sender {
  const now = opts.now ?? Date.now;
  return async (notification, signal) => {
    const body = JSON.stringify(notification);
    const headers: Record<string, string> = { "idempotency-key": notification.key };
    if (channel.secret !== undefined) {
      headers["x-pulse-signature"] = signBody(channel.secret, body);
      headers["x-pulse-timestamp"] = String(Math.floor(now() / 1000));
    }
    await postJson("webhook", channel.url, headers, body, opts, signal);
  };
}
