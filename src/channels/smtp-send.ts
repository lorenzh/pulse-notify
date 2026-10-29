import { createTransport, type SentMessageInfo } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { PermanentDeliveryError } from "../errors.ts";
import { defaultSchedule } from "../timeout.ts";
import { isLoopbackHost } from "./loopback.ts";
import {
  DEFAULT_CLIENT_NAME,
  type MailMessage,
  type SendMail,
  type SmtpOptions,
} from "./mailer.ts";

export class SmtpError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SmtpError";
  }
}

function assertSafe(smtp: SmtpOptions, message: MailMessage): void {
  for (const value of [smtp.host, message.from, message.subject, ...message.to]) {
    if (/[\r\n]/.test(value)) throw new SmtpError("SMTP address or subject contains a line break");
  }
  if (smtp.username !== undefined && smtp.tls === "none" && !isLoopbackHost(smtp.host)) {
    throw new SmtpError("SMTP refuses to send credentials over an unencrypted connection");
  }
}

/** Nodemailer prefers PLAIN, then LOGIN. These stop it from ever falling back to another method. */
const refuseMechanism = async (): Promise<void> => {
  throw new SmtpError("SMTP server offers no supported AUTH mechanism");
};

function transportOptions(smtp: SmtpOptions): SMTPTransport.Options {
  const hasLogin = smtp.username !== undefined && smtp.password !== undefined;
  return {
    host: smtp.host,
    port: smtp.port,
    secure: smtp.tls === "tls",
    requireTLS: smtp.tls === "starttls",
    ignoreTLS: smtp.tls === "none",
    name: smtp.clientName ?? DEFAULT_CLIENT_NAME,
    pool: false,
    // Nodemailer's own timers stay behind the whole-attempt timer.
    connectionTimeout: smtp.timeoutMs,
    greetingTimeout: smtp.timeoutMs,
    socketTimeout: smtp.timeoutMs,
    ...(hasLogin
      ? {
          auth: { user: smtp.username, pass: smtp.password },
          forceAuth: true,
          customAuth: { "CRAM-MD5": refuseMechanism, XOAUTH2: refuseMechanism },
        }
      : {}),
    ...(smtp.tlsOptions ? { tls: smtp.tlsOptions } : {}),
  };
}

function field(err: unknown, key: string): unknown {
  return typeof err === "object" && err !== null ? Reflect.get(err, key) : undefined;
}

/** Maps a nodemailer failure to our errors. The text comes from codes only, never from the server. */
function classify(err: unknown): Error {
  const code = field(err, "code");
  const status = field(err, "responseCode");
  const isPermanent = typeof status === "number" && status >= 500 && status <= 599;
  const suffix = typeof status === "number" ? `: ${status}` : "";
  if (code === "EAUTH") {
    const message = `SMTP AUTH failed${suffix}`;
    return isPermanent
      ? new PermanentDeliveryError(message, { status: Number(status), cause: err })
      : new SmtpError(message, { cause: err });
  }
  if (isPermanent) {
    return new PermanentDeliveryError(`SMTP failed${suffix}`, {
      status: Number(status),
      cause: err,
    });
  }
  if (code === "EENVELOPE" || code === "EMESSAGE") {
    return new SmtpError(`SMTP rejected the message${suffix}`, { cause: err });
  }
  const label = typeof code === "string" ? code : "error";
  return new SmtpError(`SMTP failed: ${suffix === "" ? label : String(status)}`, { cause: err });
}

/** Nodemailer sends when only some recipients were refused. A notification must reach all of them. */
function assertAllAccepted(info: SentMessageInfo): void {
  const errors: unknown = field(info, "rejectedErrors");
  const first: unknown = Array.isArray(errors) ? errors[0] : undefined;
  const rejected: unknown = field(info, "rejected");
  if (first !== undefined) throw classify(first);
  if (Array.isArray(rejected) && rejected.length > 0) {
    throw new SmtpError("SMTP recipient rejected");
  }
}

function isBadAddress(err: unknown): boolean {
  return field(err, "code") === "EENVELOPE" && field(err, "responseCode") === undefined;
}

/**
 * Sends one message with nodemailer. `timeoutMs` covers the whole attempt. A 5xx reply rejects
 * with a `PermanentDeliveryError`; timeout, abort and network errors are retryable.
 */
export const sendMail: SendMail = async (smtp, message) => {
  assertSafe(smtp, message);
  // The channel's `tls` setting picks the mode; `none` is allowed only without login or on loopback.
  // eslint-disable-next-line sonarjs/no-clear-text-protocols
  const transporter = createTransport(transportOptions(smtp));
  let cancel: () => void = () => {};
  let detach: () => void = () => {};
  const limit = new Promise<never>((_, reject) => {
    cancel = (smtp.schedule ?? defaultSchedule)(
      () => reject(new SmtpError(`SMTP send timed out after ${smtp.timeoutMs}ms`)),
      smtp.timeoutMs,
    );
    const signal = smtp.signal;
    if (!signal) return;
    const onAbort = (): void => reject(new SmtpError("SMTP send aborted"));
    if (signal.aborted) onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    detach = () => signal.removeEventListener("abort", onAbort);
  });
  // The race below handles a rejection; this keeps an unraced one from being unhandled.
  limit.catch(() => {});
  const sending: Promise<SentMessageInfo> = transporter.sendMail({
    from: message.from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    date: message.date,
    messageId: message.messageId,
  });
  // If the limit wins, the late result of the send is of no interest.
  sending.catch(() => {});
  try {
    assertAllAccepted(await Promise.race([sending, limit]));
  } catch (err) {
    if (err instanceof SmtpError || err instanceof PermanentDeliveryError) throw err;
    if (isBadAddress(err)) {
      throw new PermanentDeliveryError("SMTP address is not valid", { cause: err });
    }
    throw classify(err);
  } finally {
    cancel();
    detach();
    transporter.close();
  }
};
