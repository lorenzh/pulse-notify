import { createHash } from "node:crypto";
import type { EmailChannelConfig, Schedule, Sender } from "../types.ts";
import { cleanText, type MessageParts, messageParts } from "./message.ts";
import type { SendMail } from "./smtp.ts";

export interface EmailOptions {
  sendMail: SendMail;
  timeoutMs?: number | undefined;
  schedule?: Schedule | undefined;
  now?: (() => number) | undefined;
}

/** The address inside `Name <addr>`, or the text itself. */
export function envelopeAddress(value: string): string {
  const match = /<([^<>]*)>\s*$/.exec(value);
  return (match?.[1] ?? value).trim();
}

function encodeHeader(text: string): string {
  return /^[ -~]*$/.test(text)
    ? text
    : `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

function bodyText(parts: MessageParts): string {
  const lines = [`${parts.name} is ${parts.state}.`, "", `Check: ${parts.name}`];
  lines.push(`State: ${parts.state}`);
  if (parts.reason !== undefined) lines.push(`Reason: ${parts.reason}`);
  lines.push(`Time: ${parts.time}`);
  if (parts.openFor !== undefined) lines.push(`Open for: ${parts.openFor}`);
  if (parts.link !== undefined) lines.push(`Status: ${parts.link}`);
  return `${lines.join("\r\n")}\r\n`;
}

function wrap76(text: string): string {
  return (text.match(/.{1,76}/g) ?? []).join("\r\n");
}

/** Message-ID derived from the notification key, so receivers can deduplicate a resend. */
function messageId(key: string, from: string): string {
  const domain = envelopeAddress(from).split("@")[1] ?? "localhost";
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return `<${hash}@${domain}>`;
}

export function createEmailSender(channel: EmailChannelConfig, opts: EmailOptions): Sender {
  const now = opts.now ?? Date.now;
  return async (notification, signal) => {
    const parts = messageParts(notification, channel);
    const prefix =
      channel.subjectPrefix === undefined ? "" : `${cleanText(channel.subjectPrefix, 100)} `;
    const subject = `${prefix}${parts.state}: ${parts.name}`;
    const headers = [
      `From: ${channel.from}`,
      `To: ${channel.to.join(", ")}`,
      `Subject: ${encodeHeader(subject)}`,
      `Date: ${new Date(now()).toUTCString()}`,
      `Message-ID: ${messageId(notification.key, channel.from)}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
    ];
    const body = wrap76(Buffer.from(bodyText(parts), "utf8").toString("base64"));
    await opts.sendMail(
      {
        ...channel.smtp,
        timeoutMs: opts.timeoutMs ?? 5000,
        schedule: opts.schedule,
        signal,
      },
      {
        from: envelopeAddress(channel.from),
        to: channel.to.map(envelopeAddress),
        data: `${headers.join("\r\n")}\r\n\r\n${body}\r\n`,
      },
    );
  };
}
