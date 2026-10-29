import { createHash } from "node:crypto";
import type { EmailChannelConfig, Schedule, Sender } from "../types.ts";
import { DEFAULT_CLIENT_NAME, ehloNameFrom, envelopeAddress, type SendMail } from "./mailer.ts";
import { cleanText, type MessageParts, messageParts } from "./message.ts";

export interface EmailOptions {
  sendMail: SendMail;
  timeoutMs?: number | undefined;
  schedule?: Schedule | undefined;
  now?: (() => number) | undefined;
  /** Global EHLO name (`PULSE_NOTIFY_SMTP_CLIENT_NAME`); a channel's `smtp.clientName` wins. */
  clientName?: string | undefined;
  /** Machine host name, the EHLO name when nothing is set. */
  hostname?: (() => string) | undefined;
}

function bodyText(parts: MessageParts): string {
  const lines = [`${parts.name} is ${parts.state}.`, "", `Check: ${parts.name}`];
  lines.push(`State: ${parts.state}`);
  if (parts.reason !== undefined) lines.push(`Reason: ${parts.reason}`);
  lines.push(`Time: ${parts.time}`);
  if (parts.openFor !== undefined) lines.push(`Open for: ${parts.openFor}`);
  if (parts.link !== undefined) lines.push(`Status: ${parts.link}`);
  return `${lines.join("\n")}\n`;
}

/** Message-ID derived from the notification key, so receivers can deduplicate a resend. */
function messageId(key: string, from: string): string {
  const domain = envelopeAddress(from).split("@")[1] ?? "localhost";
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return `<${hash}@${domain}>`;
}

export function createEmailSender(channel: EmailChannelConfig, opts: EmailOptions): Sender {
  const now = opts.now ?? Date.now;
  const clientName =
    channel.smtp.clientName ??
    opts.clientName ??
    (opts.hostname ? ehloNameFrom(opts.hostname()) : DEFAULT_CLIENT_NAME);
  return async (notification, signal) => {
    const parts = messageParts(notification, channel);
    const prefix =
      channel.subjectPrefix === undefined ? "" : `${cleanText(channel.subjectPrefix, 100)} `;
    const subject = `${prefix}${parts.state}: ${parts.name}`;
    await opts.sendMail(
      {
        ...channel.smtp,
        clientName,
        timeoutMs: opts.timeoutMs ?? 5000,
        schedule: opts.schedule,
        signal,
      },
      {
        from: channel.from,
        to: channel.to,
        subject,
        text: bodyText(parts),
        date: new Date(now()),
        messageId: messageId(notification.key, channel.from),
      },
    );
  };
}
