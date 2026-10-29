import { fetchWithTimeout } from "../timeout.ts";
import type { Schedule, Sender, WebhookChannelConfig } from "../types.ts";

export interface WebhookOptions {
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  schedule?: Schedule;
}

export function createWebhookSender(
  channel: WebhookChannelConfig,
  opts: WebhookOptions = {},
): Sender {
  return async (notification, signal) => {
    const status = await fetchWithTimeout(
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
        ...(signal ? { signal } : {}),
      },
      opts.timeoutMs ?? 5000,
      async (res) => {
        await res.body?.cancel();
        return res.status;
      },
      opts.schedule,
    );
    if (status < 200 || status > 299) {
      throw new Error(`webhook responded with status ${status}`);
    }
  };
}
