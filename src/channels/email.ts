import { createHash } from "node:crypto";
import { PartialDeliveryError } from "../errors.ts";
import type { EmailChannelConfig, RecipientProgress, Schedule, Sender } from "../types.ts";
import {
  DEFAULT_CLIENT_NAME,
  ehloNameFrom,
  envelopeAddress,
  recipientId,
  type SendMail,
  type SendMailResult,
} from "./mailer.ts";
import { cleanText, type MessageParts, messageParts, type WarningParts } from "./message.ts";

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

function warningBody(parts: MessageParts, warning: WarningParts): string {
  const lines = [`${parts.state}: ${parts.name}`, "", `${warning.subjectKind}: ${parts.name}`];
  for (const fact of warning.facts) lines.push(`${fact.title}: ${fact.value}`);
  lines.push(`Time: ${parts.time}`);
  if (parts.link !== undefined) lines.push(`Status: ${parts.link}`);
  return `${lines.join("\n")}\n`;
}

function bodyText(parts: MessageParts): string {
  if (parts.warning) return warningBody(parts, parts.warning);
  const m = parts.manual;
  const lines = m
    ? [`${parts.state}: ${parts.name}`, "", `Incident: ${parts.name}`]
    : [`${parts.name} is ${parts.state}.`, "", `Check: ${parts.name}`];
  if (m) {
    lines.push(`Impact: ${m.impact}`, `Status: ${m.status}`, `Message: ${m.message}`);
    if (m.components !== "") lines.push(`Components: ${m.components}`);
  } else {
    lines.push(`State: ${parts.state}`);
  }
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

const NO_PROGRESS: RecipientProgress = { delivered: [], refused: [] };

/** The recipient ids that are neither delivered nor refused. */
function remainingIds(ids: string[], progress: RecipientProgress): string[] {
  const done = new Set([...progress.delivered, ...progress.refused]);
  return ids.filter((id) => !done.has(id));
}

/**
 * Adds this attempt's result to `progress`. Only an address that matches a remaining id counts:
 * an unexpected one is ignored, so its recipient stays remaining (at-least-once).
 */
function applyResult(
  remaining: string[],
  result: SendMailResult,
  progress: RecipientProgress,
): void {
  const open = new Set(remaining);
  const take = (address: string): string | undefined => {
    const id = open.has(address) ? address : recipientId(address);
    if (!open.has(id)) return undefined;
    open.delete(id);
    return id;
  };
  for (const { recipient, responseCode } of result.refused) {
    if (responseCode === undefined || responseCode < 500 || responseCode > 599) continue;
    const id = take(recipient);
    if (id !== undefined) progress.refused.push(id);
  }
  for (const address of result.accepted) {
    const id = take(address);
    if (id !== undefined) progress.delivered.push(id);
  }
}

/**
 * Resolves when every current recipient has the message; otherwise throws `PartialDeliveryError`.
 * A refused recipient that was removed from the config no longer counts.
 */
function settleAttempt(
  ids: string[],
  remaining: string[],
  after: RecipientProgress,
  result: SendMailResult,
): void {
  const delivered = new Set(after.delivered);
  const refused = new Set(after.refused);
  const left = remaining.filter((id) => !delivered.has(id) && !refused.has(id)).length;
  const missing = ids.filter((id) => !delivered.has(id)).length;
  if (missing === 0) return;
  const codes = result.refused.flatMap((r) =>
    r.responseCode === undefined ? [] : [r.responseCode],
  );
  throw new PartialDeliveryError({
    progress: after,
    remaining: left,
    refusedNow: missing,
    attempted: ids.length,
    codes,
  });
}

export function createEmailSender(channel: EmailChannelConfig, opts: EmailOptions): Sender {
  const now = opts.now ?? Date.now;
  const clientName =
    channel.smtp.clientName ??
    opts.clientName ??
    (opts.hostname ? ehloNameFrom(opts.hostname()) : DEFAULT_CLIENT_NAME);
  return async (notification, signal, progress = NO_PROGRESS) => {
    const ids = [...new Set(channel.to.map(recipientId))];
    const remaining = remainingIds(ids, progress);
    if (remaining.length === 0) {
      // Nothing left to send: no connection.
      settleAttempt(ids, remaining, progress, { accepted: [], refused: [] });
      return;
    }
    const parts = messageParts(notification, channel);
    const prefix =
      channel.subjectPrefix === undefined ? "" : `${cleanText(channel.subjectPrefix, 100)} `;
    const subject = `${prefix}${parts.state}: ${parts.name}`;
    const result = await opts.sendMail(
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
        envelopeTo: remaining,
        subject,
        text: bodyText(parts),
        date: new Date(now()),
        messageId: messageId(notification.key, channel.from),
      },
    );
    const after = { delivered: [...progress.delivered], refused: [...progress.refused] };
    applyResult(remaining, result, after);
    settleAttempt(ids, remaining, after, result);
  };
}
