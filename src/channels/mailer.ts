import type { ConnectionOptions } from "node:tls";
import type { Schedule, SmtpConfig } from "../types.ts";

export const DEFAULT_CLIENT_NAME = "localhost";

const HOST_LABEL = /^[A-Za-z0-9-]{1,63}$/;
const LITERAL_BODY = /^[0-9A-Fa-f:.]+$/;

function isAddressLiteral(value: string): boolean {
  if (!value.startsWith("[") || !value.endsWith("]")) return false;
  return LITERAL_BODY.test(value.slice(1, -1).replace(/^IPv6:/, ""));
}

function isHostName(value: string): boolean {
  return value
    .split(".")
    .every((label) => HOST_LABEL.test(label) && !label.startsWith("-") && !label.endsWith("-"));
}

/** True for a host name or an address literal (`[192.0.2.1]`) of at most 255 characters. */
export function isEhloName(value: string): boolean {
  return value.length <= 255 && (isHostName(value) || isAddressLiteral(value));
}

/** An EHLO token from a machine host name: invalid characters become `-`; `localhost` if nothing is left. */
export function ehloNameFrom(hostname: string): string {
  const chars = [...hostname.replaceAll(/[^A-Za-z0-9.-]/g, "-")];
  while (chars[0] === "-" || chars[0] === ".") chars.shift();
  while (chars.at(-1) === "-" || chars.at(-1) === ".") chars.pop();
  const cleaned = chars.join("");
  return isEhloName(cleaned) ? cleaned : DEFAULT_CLIENT_NAME;
}

/** The address inside `Name <addr>`, or the text itself. */
export function envelopeAddress(value: string): string {
  const match = /<([^<>]*)>\s*$/.exec(value);
  return (match?.[1] ?? value).trim();
}

export interface SmtpOptions extends SmtpConfig {
  timeoutMs: number;
  schedule?: Schedule | undefined;
  signal?: AbortSignal | undefined;
  /** Extra TLS options, for example a test `ca`. Certificate verification stays on. */
  tlsOptions?: ConnectionOptions | undefined;
}

export interface MailMessage {
  /** Sender, plain or `Name <addr>`. */
  from: string;
  /** Recipients, plain or `Name <addr>`. */
  to: string[];
  subject: string;
  /** Plain text body. */
  text: string;
  date: Date;
  /** Message-ID with angle brackets. */
  messageId: string;
}

export type SendMail = (smtp: SmtpOptions, message: MailMessage) => Promise<void>;
