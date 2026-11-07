import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  SUBSCRIPTION_CLEANUP_INTERVAL_MS,
  SUBSCRIPTION_CONFIRM_TTL_MS,
  SUBSCRIPTION_UNSUBSCRIBE_TOKEN_PATTERN,
} from "@lorenzh/pulse-contract";
import { envelopeAddress, type MailMessage } from "./channels/mailer.ts";

const HOUR_MS = 3_600_000;

export type RandomBytes = (size: number) => Buffer;

const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The SHA-256 hex digest of a confirmation token; the store keeps only this (D8). */
export function tokenDigest(token: string): string {
  return sha256Hex(token);
}

/** A new confirmation token (32 random bytes, base64url, 43 characters) and its digest. */
export function newConfirmToken(random: RandomBytes = randomBytes): {
  token: string;
  digest: string;
} {
  const token = random(32).toString("base64url");
  return { token, digest: tokenDigest(token) };
}

/** A new row id: 16 random bytes, base64url, 22 characters (D8). */
export function newSubscriptionId(random: RandomBytes = randomBytes): string {
  return random(16).toString("base64url");
}

function unsubscribeMac(id: string, keyHex: string): Buffer {
  return createHmac("sha256", Buffer.from(keyHex, "hex"))
    .update(`pulse-unsubscribe:${id}`)
    .digest();
}

/** `<id>.<mac>`: the unsubscribe token of a row; notify never stores it (D8). */
export function unsubscribeToken(id: string, keyHex: string): string {
  return `${id}.${unsubscribeMac(id, keyHex).toString("base64url")}`;
}

/** The row id of an unsubscribe token whose `mac` is right, compared in constant time; else `undefined`. */
export function unsubscribeTokenId(token: string, keyHex: string): string | undefined {
  if (!SUBSCRIPTION_UNSUBSCRIBE_TOKEN_PATTERN.test(token)) return undefined;
  const [id = "", mac = ""] = token.split(".");
  const given = Buffer.from(mac, "base64url");
  const expected = unsubscribeMac(id, keyHex);
  return given.length === expected.length && timingSafeEqual(given, expected) ? id : undefined;
}

/** `<first 32 hex of sha256(seed)>@<domain of from>`, in angle brackets. */
export function messageId(seed: string, from: string): string {
  const address = envelopeAddress(from);
  const domain = address.slice(address.lastIndexOf("@") + 1);
  return `<${sha256Hex(seed).slice(0, 32)}@${domain}>`;
}

export interface ConfirmationInput {
  from: string;
  subjectPrefix: string;
  /** The status origin, without a path or trailing `/` (R9). */
  statusUrl: string;
  address: string;
  id: string;
  confirmSends: number;
  confirmToken: string;
  unsubscribeToken: string;
  date: Date;
}

/** The confirmation mail of R5: one `To` address, links on the configured origin only. */
export function confirmationMessage(input: ConfirmationInput): MailMessage {
  const url = input.statusUrl;
  const ttlHours = SUBSCRIPTION_CONFIRM_TTL_MS / HOUR_MS;
  const goneHours = (SUBSCRIPTION_CONFIRM_TTL_MS + SUBSCRIPTION_CLEANUP_INTERVAL_MS) / HOUR_MS;
  const text = [
    `Someone asked to get incident updates of ${url} at this address.`,
    "",
    `Confirm: ${url}/subscribe/confirm?token=${input.confirmToken}`,
    `The link works for ${ttlHours} hours. If you did not ask for this, ignore this email.`,
    `If you do not confirm, your address is deleted within ${goneHours} hours.`,
    "",
    `Unsubscribe: ${url}/unsubscribe?token=${input.unsubscribeToken}`,
    `About your data: ${url}/#subscribe-notice`,
    "",
  ].join("\n");
  return {
    from: input.from,
    to: [input.address],
    envelopeTo: [input.address],
    subject: `${input.subjectPrefix} Confirm your subscription`,
    text,
    date: input.date,
    messageId: messageId(`confirm:${input.id}:${input.confirmSends}`, input.from),
  };
}
