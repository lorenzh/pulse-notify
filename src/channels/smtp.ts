import { isIP, connect as netConnect, type Socket } from "node:net";
import { type ConnectionOptions, connect as tlsConnect } from "node:tls";
import { PermanentDeliveryError } from "../errors.ts";
import { defaultSchedule } from "../timeout.ts";
import type { Schedule, SmtpConfig } from "../types.ts";
import { isLoopbackHost } from "./loopback.ts";

export class SmtpError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SmtpError";
  }
}

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

export interface SmtpOptions extends SmtpConfig {
  timeoutMs: number;
  schedule?: Schedule | undefined;
  signal?: AbortSignal | undefined;
  /** Extra TLS options, for example a test `ca`. Certificate verification stays on. */
  tlsOptions?: ConnectionOptions | undefined;
}

export interface SmtpMessage {
  /** Envelope sender address. */
  from: string;
  /** Envelope recipient addresses. */
  to: string[];
  /** Full message (headers, blank line, body) with any line ending. */
  data: string;
}

export type SendMail = (smtp: SmtpOptions, message: SmtpMessage) => Promise<void>;

interface Reply {
  code: number;
  lines: string[];
  /** Characters of all lines, for the size cap. */
  size: number;
}

/** One limit for a whole attempt: the timer starts at connect and the abort signal joins it. */
interface Guard {
  /** Rejects when the attempt timer fires or the signal aborts. Never resolves. */
  limit: Promise<never>;
  /** The stage that the timeout message names. */
  stage: { name: string };
}

const MAX_BUFFER = 64 * 1024;
/** Longest reply in lines, and most bytes held in unread reply lines. */
const MAX_REPLY_LINES = 100;
const MAX_REPLY_BYTES = 64 * 1024;

function createGuard(
  ms: number,
  schedule: Schedule,
  signal: AbortSignal | undefined,
): { guard: Guard; dispose: () => void } {
  const stage = { name: "connect" };
  let cancel: () => void = () => {};
  let detach: () => void = () => {};
  const limit = new Promise<never>((_, reject) => {
    cancel = schedule(
      () => reject(new SmtpError(`SMTP ${stage.name} timed out after ${ms}ms`)),
      ms,
    );
    if (!signal) return;
    const onAbort = (): void => reject(new SmtpError("SMTP send aborted"));
    if (signal.aborted) onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    detach = () => signal.removeEventListener("abort", onAbort);
  });
  // The race in `guarded` handles a rejection; this keeps an unraced one from being unhandled.
  limit.catch(() => {});
  return {
    guard: { stage, limit },
    dispose: () => {
      cancel();
      detach();
    },
  };
}

/** Rejects when `promise` does, or when the attempt limit is reached. */
function guarded<T>(promise: Promise<T>, guard: Guard, what: string): Promise<T> {
  guard.stage.name = what;
  return Promise.race([promise, guard.limit]);
}

/** Line and reply reader on top of a socket that can be upgraded to TLS. */
class Session {
  #socket: Socket;
  #buffer = "";
  #partial: string[] = [];
  #partialSize = 0;
  #replies: Reply[] = [];
  #failure: Error | undefined;
  #waiter: { resolve: (r: Reply) => void; reject: (e: Error) => void } | undefined;
  readonly #onData = (chunk: string): void => {
    this.#buffer += chunk;
    this.#parse();
  };
  readonly #onError = (err: Error): void => this.#fail(err);
  readonly #onClose = (): void => this.#fail(new SmtpError("SMTP connection closed"));

  constructor(socket: Socket) {
    this.#socket = socket;
    this.#bind(socket);
  }

  get socket(): Socket {
    return this.#socket;
  }

  #bind(socket: Socket): void {
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", this.#onData);
    socket.on("error", this.#onError);
    socket.on("close", this.#onClose);
  }

  #unbind(): void {
    this.#socket.off("data", this.#onData);
    this.#socket.off("error", this.#onError);
    this.#socket.off("close", this.#onClose);
  }

  #fail(err: Error): void {
    this.#failure ??= err;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.reject(this.#failure);
  }

  #parse(): void {
    for (let end = this.#buffer.indexOf("\n"); end >= 0; end = this.#buffer.indexOf("\n")) {
      const line = this.#buffer.slice(0, end).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(end + 1);
      this.#addLine(line);
    }
    if (this.#buffer.length > MAX_BUFFER) this.#fail(new SmtpError("SMTP reply too long"));
  }

  #addLine(line: string): void {
    const match = /^(\d{3})([ -]|$)(.*)$/.exec(line);
    if (!match) {
      this.#fail(new SmtpError("SMTP server sent a malformed reply"));
      return;
    }
    const text = match[3] ?? "";
    this.#partial.push(text);
    this.#partialSize += text.length + 4;
    if (this.#isOverCap()) {
      this.#fail(new SmtpError("SMTP reply too long"));
      return;
    }
    if (match[2] === "-") return;
    const reply = { code: Number(match[1]), lines: this.#partial, size: this.#partialSize };
    this.#partial = [];
    this.#partialSize = 0;
    const waiter = this.#waiter;
    if (waiter) {
      this.#waiter = undefined;
      waiter.resolve(reply);
    } else {
      this.#replies.push(reply);
    }
  }

  /** Too many lines in one reply, or too many bytes in the partial plus the queued replies. */
  #isOverCap(): boolean {
    if (this.#partial.length > MAX_REPLY_LINES) return true;
    const queued = this.#replies.reduce((sum, r) => sum + r.size, 0);
    return queued + this.#partialSize > MAX_REPLY_BYTES;
  }

  #read(): Promise<Reply> {
    const queued = this.#replies.shift();
    if (queued) return Promise.resolve(queued);
    if (this.#failure) return Promise.reject(this.#failure);
    return new Promise((resolve, reject) => {
      this.#waiter = { resolve, reject };
    });
  }

  /** Sends `line` (if any), reads one reply and rejects unless `accept` allows its code. */
  async command(
    guard: Guard,
    what: string,
    line: string | undefined,
    accept: (code: number) => boolean,
  ): Promise<Reply> {
    if (line !== undefined) this.#socket.write(`${line}\r\n`);
    const reply = await guarded(this.#read(), guard, what);
    if (!accept(reply.code)) {
      // AUTH replies can echo credentials, so only the code is reported.
      const text = what === "AUTH" ? "" : (reply.lines[0] ?? "").slice(0, 200);
      const message = `SMTP ${what} failed: ${reply.code} ${text}`.trim();
      // The final reply code decides: 5xx will not change on a retry, 4xx and others may.
      if (reply.code >= 500 && reply.code <= 599) {
        throw new PermanentDeliveryError(message, { status: reply.code });
      }
      throw new SmtpError(message);
    }
    return reply;
  }

  write(data: string): void {
    this.#socket.write(data);
  }

  /** Wraps the open socket in TLS. Anything buffered or queued before the handshake is dropped. */
  async upgrade(host: string, extra: ConnectionOptions | undefined, guard: Guard): Promise<void> {
    this.#unbind();
    // The TLS socket forwards errors of the plain one; this keeps a late one from crashing.
    this.#socket.on("error", () => {});
    // Bytes that arrived before the handshake came from the plain connection: never trust them.
    this.#buffer = "";
    this.#replies = [];
    this.#partial = [];
    this.#partialSize = 0;
    this.#waiter = undefined;
    const secure = tlsConnect({
      socket: this.#socket,
      ...(isIP(host) === 0 ? { servername: host } : {}),
      ...extra,
    });
    const done = new Promise<void>((resolve, reject) => {
      secure.once("secureConnect", () => resolve());
      secure.once("error", reject);
    });
    this.#bind(secure);
    try {
      await guarded(done, guard, "STARTTLS handshake");
    } catch (err) {
      secure.destroy();
      throw err;
    }
  }

  destroy(): void {
    this.#socket.destroy();
  }
}

const is2xx = (code: number): boolean => code >= 200 && code < 300;
const isCode =
  (expected: number) =>
  (code: number): boolean =>
    code === expected;

function createSocket(smtp: SmtpOptions): Socket {
  if (smtp.tls !== "tls") return netConnect({ host: smtp.host, port: smtp.port });
  return tlsConnect({
    host: smtp.host,
    port: smtp.port,
    ...(isIP(smtp.host) === 0 ? { servername: smtp.host } : {}),
    ...smtp.tlsOptions,
  });
}

async function ehlo(session: Session, guard: Guard, name: string): Promise<string[]> {
  const reply = await session.command(guard, "EHLO", `EHLO ${name}`, is2xx);
  return reply.lines.map((l) => l.toUpperCase());
}

async function authenticate(
  session: Session,
  guard: Guard,
  user: string,
  password: string,
  capabilities: string[],
): Promise<void> {
  const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
  const mechanisms = capabilities.find((l) => l.startsWith("AUTH ")) ?? "";
  if (mechanisms.split(" ").includes("PLAIN")) {
    const credentials = b64(`\0${user}\0${password}`);
    await session.command(guard, "AUTH", `AUTH PLAIN ${credentials}`, isCode(235));
  } else if (mechanisms.split(" ").includes("LOGIN")) {
    await session.command(guard, "AUTH", "AUTH LOGIN", isCode(334));
    await session.command(guard, "AUTH", b64(user), isCode(334));
    await session.command(guard, "AUTH", b64(password), isCode(235));
  } else {
    throw new SmtpError("SMTP server offers no supported AUTH mechanism (PLAIN, LOGIN)");
  }
}

/** Normalizes line endings to CRLF and doubles a leading dot on every line. */
export function dotStuff(data: string): string {
  const lines = data.replace(/\r\n|\r|\n/g, "\r\n").split("\r\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const stuffed = lines.map((l) => (l.startsWith(".") ? "." + l : l));
  return `${stuffed.join("\r\n")}\r\n`;
}

function assertSafe(smtp: SmtpOptions, message: SmtpMessage): void {
  for (const value of [smtp.host, message.from, ...message.to]) {
    if (/[\r\n]/.test(value)) throw new SmtpError("SMTP address contains a line break");
  }
  if (smtp.username !== undefined && smtp.tls === "none" && !isLoopbackHost(smtp.host)) {
    throw new SmtpError("SMTP refuses to send credentials over an unencrypted connection");
  }
}

async function negotiate(session: Session, smtp: SmtpOptions, guard: Guard): Promise<void> {
  const name = smtp.clientName ?? DEFAULT_CLIENT_NAME;
  await session.command(guard, "greeting", undefined, isCode(220));
  let capabilities = await ehlo(session, guard, name);
  if (smtp.tls === "starttls") {
    if (!capabilities.includes("STARTTLS")) {
      throw new SmtpError("SMTP server does not offer STARTTLS");
    }
    await session.command(guard, "STARTTLS", "STARTTLS", isCode(220));
    await session.upgrade(smtp.host, smtp.tlsOptions, guard);
    capabilities = await ehlo(session, guard, name);
  }
  if (smtp.username !== undefined && smtp.password !== undefined) {
    await authenticate(session, guard, smtp.username, smtp.password, capabilities);
  }
}

async function transmit(session: Session, message: SmtpMessage, guard: Guard): Promise<void> {
  await session.command(guard, "MAIL FROM", `MAIL FROM:<${message.from}>`, is2xx);
  for (const rcpt of message.to) {
    await session.command(guard, "RCPT TO", `RCPT TO:<${rcpt}>`, is2xx);
  }
  await session.command(guard, "DATA", "DATA", isCode(354));
  session.write(`${dotStuff(message.data)}.\r\n`);
  await session.command(guard, "message", undefined, is2xx);
}

/**
 * Sends one message. Rejects on a non-2xx reply, a socket failure, a timeout or an abort.
 * `timeoutMs` covers the whole attempt, from connect to QUIT. A 5xx reply rejects with a
 * `PermanentDeliveryError`.
 */
export async function sendMail(smtp: SmtpOptions, message: SmtpMessage): Promise<void> {
  assertSafe(smtp, message);
  const { guard, dispose } = createGuard(
    smtp.timeoutMs,
    smtp.schedule ?? defaultSchedule,
    smtp.signal,
  );
  const session = new Session(createSocket(smtp));
  try {
    await negotiate(session, smtp, guard);
    await transmit(session, message, guard);
    // QUIT is courtesy: the message is already accepted, so a failure here is ignored.
    await session.command(guard, "QUIT", "QUIT", is2xx).catch(() => {});
  } finally {
    dispose();
    session.destroy();
  }
}
