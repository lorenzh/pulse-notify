import { dirname, join } from "node:path";
import {
  type Env,
  readEnum,
  readInt,
  readMs,
  readPort,
  readSecretFile,
  readString,
  StartupError,
} from "@lorenzh/pulse-kit";
import { isLoopbackHost } from "./channels/loopback.ts";
import { envelopeAddress } from "./channels/mailer.ts";
import type { SmtpConfig } from "./types.ts";

/** A subscriber send attempt never runs longer than this, whatever `PULSE_NOTIFY_TIMEOUT_MS` says (D12). */
export const MAX_SUBSCRIBER_SEND_MS = 60_000;

export const STORE_FILE_NAME = "notify-subscriptions.db";

export const ROOT_HOSTING_LINE =
  "PULSE_NOTIFY_SUBSCRIPTIONS_STATUS_URL: must be an origin without a path (root hosting)";

export interface SubscriptionsOn {
  isOn: true;
  /** The status page origin: no path and no trailing `/`. */
  statusUrl: string;
  from: string;
  subjectPrefix: string;
  smtp: SmtpConfig;
  /** The bearer token that status sends. */
  token: string;
  /** The HMAC key as 64 lowercase hex characters. */
  key: string;
  host: string;
  port: number;
  statePath: string;
  max: number;
  maxPending: number;
  confirmPerHour: number;
  /** `min(PULSE_NOTIFY_TIMEOUT_MS, 60000)`. */
  sendTimeoutMs: number;
}

export type SubscriptionSettings = { isOn: false } | SubscriptionsOn;

export interface SubscriptionReadOptions {
  /** Reads a secret file; injected so tests need no real file system. */
  readFile?: (path: string) => string;
}

function invalid(name: string, rule: string): StartupError {
  return new StartupError(`${name}: ${rule}`, { setting: name });
}

function required(env: Env, name: string): string {
  const value = readString(env, name);
  if (value === undefined) throw invalid(name, "is required");
  return value;
}

/**
 * The store file: `PULSE_NOTIFY_SUBSCRIPTIONS_STATE`, else `notify-subscriptions.db` beside
 * `PULSE_NOTIFY_STATE`. The `subscribers delete` command reads only this and the lock settings.
 */
export function subscriptionStorePath(env: Env): string {
  const explicit = readString(env, "PULSE_NOTIFY_SUBSCRIPTIONS_STATE");
  if (explicit !== undefined) return explicit;
  const ledger = readString(env, "PULSE_NOTIFY_STATE") ?? "./notify-state.json";
  return join(dirname(ledger), STORE_FILE_NAME);
}

function parseUrl(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    // Reported by the caller as an invalid setting, without the value.
    return undefined;
  }
}

function isPlainHttpUrl(url: URL): boolean {
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.hostname !== "" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === ""
  );
}

/** The status origin (R3, R9). A path other than `/` is refused with the R9 line. */
function readStatusUrl(env: Env): string {
  const name = "PULSE_NOTIFY_SUBSCRIPTIONS_STATUS_URL";
  const url = parseUrl(required(env, name));
  if (url === undefined || !isPlainHttpUrl(url)) {
    throw invalid(name, "must be an http(s) URL without credentials, query or fragment");
  }
  if (url.pathname.replace(/\/$/, "") !== "") {
    throw new StartupError(ROOT_HOSTING_LINE, { setting: name });
  }
  return url.origin;
}

const isSingleLine = (text: string): boolean => !/[\r\n]/.test(text);

function readFrom(env: Env): string {
  const name = "PULSE_NOTIFY_SUBSCRIPTIONS_FROM";
  const value = required(env, name);
  if (!isSingleLine(value) || !/^[^\s<>@]+@[^\s<>@]+$/.test(envelopeAddress(value))) {
    throw invalid(name, "must hold a single-line email address");
  }
  return value;
}

function readSubjectPrefix(env: Env, statusUrl: string): string {
  const name = "PULSE_NOTIFY_SUBSCRIPTIONS_SUBJECT_PREFIX";
  const value = env[name];
  if (value === undefined || value === "") return `[${new URL(statusUrl).host}]`;
  if (!isSingleLine(value) || value.length > 64 || value.trim() === "") {
    throw invalid(name, "must be a single line of 1 to 64 characters");
  }
  return value;
}

function readSmtp(env: Env, opts: SubscriptionReadOptions): SmtpConfig {
  const hostName = "PULSE_NOTIFY_SUBSCRIPTIONS_SMTP_HOST";
  const host = required(env, hostName);
  if (/\s/.test(host)) throw invalid(hostName, "must be a host name");
  const port =
    readPort(env, "PULSE_NOTIFY_SUBSCRIPTIONS_SMTP_PORT", { fallback: 587, min: 1 }) ?? 587;
  const tls = readEnum(
    env,
    "PULSE_NOTIFY_SUBSCRIPTIONS_SMTP_TLS",
    ["starttls", "tls", "none"] as const,
    "starttls",
  );
  const userName = "PULSE_NOTIFY_SUBSCRIPTIONS_SMTP_USERNAME";
  const fileName = "PULSE_NOTIFY_SUBSCRIPTIONS_SMTP_PASSWORD_FILE";
  const username = readString(env, userName);
  const file = readString(env, fileName);
  if (username === undefined && file === undefined) return { host, port, tls };
  if (username === undefined || file === undefined) {
    throw invalid(fileName, `must be set together with ${userName}`);
  }
  if (!isSingleLine(username)) throw invalid(userName, "must be a single line");
  if (tls === "none" && !isLoopbackHost(host)) {
    throw invalid(
      "PULSE_NOTIFY_SUBSCRIPTIONS_SMTP_TLS",
      "none sends the password in clear text; use starttls or tls, or a loopback host",
    );
  }
  const password = readSecretFile(file, {
    setting: fileName,
    ...(opts.readFile === undefined ? {} : { readFile: opts.readFile }),
  });
  return { host, port, tls, username, password };
}

function readSecret(
  env: Env,
  name: string,
  opts: SubscriptionReadOptions,
  isValid: (text: string) => boolean,
  rule: string,
): string {
  const text = readSecretFile(required(env, name), {
    setting: name,
    ...(opts.readFile === undefined ? {} : { readFile: opts.readFile }),
  });
  if (!isValid(text)) throw invalid(name, rule);
  return text;
}

function readLimits(env: Env): Pick<SubscriptionsOn, "max" | "maxPending" | "confirmPerHour"> {
  const max = readInt(env, "PULSE_NOTIFY_SUBSCRIPTIONS_MAX", {
    fallback: 10_000,
    min: 1,
    max: 100_000,
  });
  const pendingName = "PULSE_NOTIFY_SUBSCRIPTIONS_MAX_PENDING";
  const maxPending = readInt(env, pendingName, { fallback: 1000, min: 1, max: 100_000 });
  if (maxPending > max) {
    throw invalid(pendingName, "must be at most PULSE_NOTIFY_SUBSCRIPTIONS_MAX");
  }
  const confirmPerHour = readInt(env, "PULSE_NOTIFY_SUBSCRIPTIONS_CONFIRM_PER_HOUR", {
    fallback: 100,
    min: 1,
    max: 10_000,
  });
  return { max, maxPending, confirmPerHour };
}

/**
 * Reads and checks every subscription setting (R3, R9) before any file is opened. With
 * `off`, nothing else is read. Errors name the variable, never its value or a file's content.
 */
export function loadSubscriptionSettings(
  env: Env,
  opts: SubscriptionReadOptions = {},
): SubscriptionSettings {
  const mode = readEnum(env, "PULSE_NOTIFY_SUBSCRIPTIONS", ["on", "off"] as const, "off");
  if (mode === "off") return { isOn: false };
  const statusUrl = readStatusUrl(env);
  const from = readFrom(env);
  const subjectPrefix = readSubjectPrefix(env, statusUrl);
  const smtp = readSmtp(env, opts);
  const token = readSecret(
    env,
    "PULSE_NOTIFY_SUBSCRIPTIONS_TOKEN_FILE",
    opts,
    (t) => /^[\x21-\x7e]{32,}$/.test(t),
    "must hold at least 32 printable ASCII characters",
  );
  const key = readSecret(
    env,
    "PULSE_NOTIFY_SUBSCRIPTIONS_KEY_FILE",
    opts,
    (t) => /^[0-9a-f]{64}$/.test(t),
    "must hold exactly 64 lowercase hex characters",
  );
  const timeoutMs = readMs(env, "PULSE_NOTIFY_TIMEOUT_MS", { fallback: 5000, min: 1 });
  return {
    isOn: true,
    statusUrl,
    from,
    subjectPrefix,
    smtp,
    token,
    key,
    host: readString(env, "PULSE_NOTIFY_SUBSCRIPTIONS_HOST") ?? "127.0.0.1",
    port: readPort(env, "PULSE_NOTIFY_SUBSCRIPTIONS_PORT", { fallback: 9300 }) ?? 9300,
    statePath: subscriptionStorePath(env),
    ...readLimits(env),
    sendTimeoutMs: Math.min(timeoutMs, MAX_SUBSCRIBER_SEND_MS),
  };
}
