import type { Logger } from "../log.ts";
import type { ChannelConfig, Schedule, Sender } from "../types.ts";
import { createEmailSender } from "./email.ts";
import { createFileSender } from "./file.ts";
import { isLoopbackHost } from "./loopback.ts";
import { createSlackSender } from "./slack.ts";
import { type SendMail, sendMail } from "./smtp.ts";
import { createTeamsSender } from "./teams.ts";
import { createWebhookSender } from "./webhook.ts";

export interface SenderDeps {
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  schedule?: Schedule | undefined;
  now?: (() => number) | undefined;
  logger: Logger;
  sendMail?: SendMail | undefined;
}

function warnIfPlainHttp(url: string, id: string, logger: Logger): void {
  const { protocol, hostname } = new URL(url);
  if (protocol === "http:" && !isLoopbackHost(hostname)) {
    logger.log("warn", "webhook sends over http to a non-local host", { channel: id });
  }
}

export function createSender(config: ChannelConfig, deps: SenderDeps): Sender {
  switch (config.type) {
    case "webhook":
      warnIfPlainHttp(config.url, config.id, deps.logger);
      return createWebhookSender(config, deps);
    case "file":
      return createFileSender(config);
    case "slack":
      return createSlackSender(config, deps);
    case "teams":
      return createTeamsSender(config, deps);
    case "email":
      return createEmailSender(config, { ...deps, sendMail: deps.sendMail ?? sendMail });
    default: {
      const unreachable: never = config;
      throw new Error(`unknown channel type ${JSON.stringify(unreachable)}`);
    }
  }
}
