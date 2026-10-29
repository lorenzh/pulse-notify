import { Socket } from "node:net";
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
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "SmtpError";
    this.code = code;
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

function transportOptions(smtp: SmtpOptions, socket: Socket): SMTPTransport.Options {
  const hasLogin = smtp.username !== undefined && smtp.password !== undefined;
  return {
    host: smtp.host,
    port: smtp.port,
    // Our own socket, so cancellation can destroy it; `transporter.close()` leaves it open.
    socket,
    secure: smtp.tls === "tls",
    // With `tls` this only stops the HELO fallback after an EHLO error; `secure` skips STARTTLS.
    requireTLS: smtp.tls !== "none",
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

/** Nodemailer's error code, if it is a plain code word. */
function codeOf(err: unknown): string | undefined {
  const code = field(err, "code");
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : undefined;
}

/**
 * Maps a nodemailer failure to our errors. The text comes from codes only, and the nodemailer
 * error is not kept as `cause`: its message and `response` hold the server's reply text.
 */
function classify(err: unknown): Error {
  const code = codeOf(err);
  const status = field(err, "responseCode");
  const isPermanent = typeof status === "number" && status >= 500 && status <= 599;
  const suffix = typeof status === "number" ? `: ${status}` : "";
  if (code === "EAUTH") {
    const message = `SMTP AUTH failed${suffix}`;
    return isPermanent
      ? new PermanentDeliveryError(message, { status: Number(status), code })
      : new SmtpError(message, code);
  }
  if (isPermanent) {
    return new PermanentDeliveryError(`SMTP failed${suffix}`, { status: Number(status), code });
  }
  if (code === "EENVELOPE" || code === "EMESSAGE") {
    return new SmtpError(`SMTP rejected the message${suffix}`, code);
  }
  return new SmtpError(`SMTP failed: ${suffix === "" ? (code ?? "error") : String(status)}`, code);
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
 * Nodemailer answers a failed EHLO with HELO, unless `requireTLS` is set, which `none` cannot use.
 * Over `none` the socket carries plain text and the second reply is the EHLO reply: on an error
 * this fails with its code and destroys the socket before nodemailer can send HELO.
 */
function refuseHeloFallback(socket: Socket, fail: (err: Error) => void): void {
  let buffer = "";
  let replies = 0;
  const onData = (chunk: Buffer): void => {
    const lines = (buffer + chunk.toString("latin1")).split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line[3] === "-") continue;
      replies += 1;
      if (replies < 2) continue;
      socket.off("data", onData);
      if (!line.startsWith("2")) {
        fail(classify({ code: "EPROTOCOL", responseCode: Number(line.slice(0, 3)) }));
        socket.destroy();
      }
      return;
    }
  };
  socket.on("data", onData);
}

/**
 * Sends one message with nodemailer. `timeoutMs` covers the whole attempt. A 5xx reply rejects
 * with a `PermanentDeliveryError`; timeout, abort and network errors are retryable.
 */
export const sendMail: SendMail = async (smtp, message) => {
  assertSafe(smtp, message);
  const socket = new Socket();
  // Nodemailer reports socket errors through its own listeners; this one only keeps an error
  // after cancellation from being unhandled.
  socket.on("error", () => {});
  // The channel's `tls` setting picks the mode; `none` is allowed only without login or on loopback.
  // eslint-disable-next-line sonarjs/no-clear-text-protocols
  const transporter = createTransport(transportOptions(smtp, socket));
  let cancel: () => void = () => {};
  let detach: () => void = () => {};
  const limit = new Promise<never>((_, reject) => {
    if (smtp.tls === "none") refuseHeloFallback(socket, reject);
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
      throw new PermanentDeliveryError("SMTP address is not valid", { code: "EENVELOPE" });
    }
    throw classify(err);
  } finally {
    cancel();
    detach();
    transporter.close();
    // After a send nodemailer has ended the socket; after a timeout or abort this closes it.
    socket.destroy();
  }
};
