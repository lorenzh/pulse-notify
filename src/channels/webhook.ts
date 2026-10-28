import { fetchWithTimeout } from "../timeout.ts";
import type { Schedule, Sender, WebhookChannelConfig } from "../types.ts";

export interface WebhookOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  schedule?: Schedule;
}

export function createWebhookSender(
  channel: WebhookChannelConfig,
  opts: WebhookOptions = {},
): Sender {
  return async (notification) => {
    const res = await fetchWithTimeout(
      opts.fetch ?? fetch,
      channel.url,
      {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          "idempotency-key": notification.key,
        },
        body: JSON.stringify(notification),
      },
      opts.timeoutMs ?? 5000,
      opts.schedule,
    );
    await res.body?.cancel();
    if (res.status < 200 || res.status > 299) {
      throw new Error(`webhook responded with status ${res.status}`);
    }
  };
}
