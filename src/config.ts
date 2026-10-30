import { readFileSync } from "node:fs";
import {
  type Env,
  type LogLevel,
  readLogLevel,
  readMs,
  readPort,
  readString,
  readUrl,
  StartupError,
} from "@lorenzh/pulse-kit";
import { z } from "zod";
import { DEFAULT_API_MAX_BYTES } from "./api.ts";
import { channelSchema, type RawChannel } from "./channel-schema.ts";
import { isLoopbackHost } from "./channels/loopback.ts";
import { isEhloName } from "./channels/mailer.ts";
import {
  DEFAULT_RETRY_ATTEMPTS,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_RETRY_MAX_DELAY_MS,
} from "./delivery.ts";
import type { ChannelConfig, Config, SmtpConfig } from "./types.ts";

export const DEFAULT_LEASE_SECONDS = 60;
export const MIN_LEASE_SECONDS = 30;

export class ConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Where secrets come from; injected so tests need no real environment. */
export interface SecretSource {
  env: Record<string, string | undefined>;
  readFile: (path: string) => string;
}

const realSource = (): SecretSource => ({
  env: process.env,
  readFile: (path) => readFileSync(path, "utf8"),
});

function trimTrailingNewlines(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === "\n" || text[end - 1] === "\r")) end--;
  return text.slice(0, end);
}

/** The `<name>Env` / `<name>File` pair of a channel, already checked for shape. */
interface SecretRefs {
  env: string | undefined;
  file: string | undefined;
}

/**
 * Reads a secret from `<name>Env` or `<name>File`. Errors name the channel and the key,
 * never the value. A file loses one trailing newline.
 */
function readSecret(
  refs: SecretRefs,
  id: string,
  name: string,
  source: SecretSource,
): string | undefined {
  const envKey = `${name}Env`;
  const fileKey = `${name}File`;
  if (refs.env === undefined && refs.file === undefined) return undefined;
  if (refs.env !== undefined && refs.file !== undefined) {
    throw new ConfigError(`channel "${id}": set only one of ${envKey} and ${fileKey}`);
  }
  const key = refs.env === undefined ? fileKey : envKey;
  const ref = refs.env ?? refs.file ?? "";
  let value: string | undefined;
  if (refs.env === undefined) {
    try {
      value = trimTrailingNewlines(source.readFile(ref));
    } catch (err) {
      throw new ConfigError(`channel "${id}": ${key}: cannot read file ${ref}`, { cause: err });
    }
  } else {
    value = source.env[ref];
  }
  if (value === undefined || value === "") {
    throw new ConfigError(`channel "${id}": ${key}: ${ref} is missing or empty`);
  }
  return value;
}

function requireSecret(refs: SecretRefs, id: string, name: string, source: SecretSource): string {
  const value = readSecret(refs, id, name, source);
  if (value === undefined) {
    throw new ConfigError(`channel "${id}": ${name}Env or ${name}File is required`);
  }
  return value;
}

/** Slack and Teams URLs are credentials: https only, except for a local test server. */
function resolveChatUrl(
  refs: { urlEnv?: string | undefined; urlFile?: string | undefined },
  id: string,
  source: SecretSource,
): string {
  const secretRefs = { env: refs.urlEnv, file: refs.urlFile };
  const url = requireSecret(secretRefs, id, "url", source);
  const key = refs.urlEnv === undefined ? "urlFile" : "urlEnv";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError(`channel "${id}": ${key} does not hold a valid url`);
  }
  const isSecure = parsed.protocol === "https:";
  const isLocalHttp = parsed.protocol === "http:" && isLoopbackHost(parsed.hostname);
  if (!isSecure && !isLocalHttp) {
    throw new ConfigError(`channel "${id}": ${key} must hold an https url`);
  }
  return url;
}

function resolveSmtp(
  smtp: Extract<RawChannel, { type: "email" }>["smtp"],
  id: string,
  source: SecretSource,
): SmtpConfig {
  const out: SmtpConfig = { host: smtp.host, port: smtp.port, tls: smtp.tls };
  if (smtp.clientName !== undefined) out.clientName = smtp.clientName;
  if (smtp.username === undefined) {
    if (smtp.passwordEnv !== undefined || smtp.passwordFile !== undefined) {
      throw new ConfigError(`channel "${id}": smtp password needs a username`);
    }
    return out;
  }
  if (smtp.tls === "none" && !isLoopbackHost(smtp.host)) {
    throw new ConfigError(
      `channel "${id}": smtp login is refused with tls "none" on a remote host`,
    );
  }
  out.username = smtp.username;
  out.password = requireSecret(
    { env: smtp.passwordEnv, file: smtp.passwordFile },
    id,
    "password",
    source,
  );
  return out;
}

/** Keys that the config leaves out stay absent in the result. */
function baseOf(
  raw: RawChannel,
): Pick<ChannelConfig, "id" | "checks" | "excludeChecks" | "remindEverySeconds"> {
  return {
    id: raw.id,
    ...(raw.checks === undefined ? {} : { checks: raw.checks }),
    ...(raw.excludeChecks === undefined ? {} : { excludeChecks: raw.excludeChecks }),
    ...(raw.remindEverySeconds === undefined ? {} : { remindEverySeconds: raw.remindEverySeconds }),
  };
}

function messageOptionsOf(raw: {
  statusUrl?: string | undefined;
  hideReason?: boolean | undefined;
}): { statusUrl?: string; hideReason?: boolean } {
  return {
    ...(raw.statusUrl === undefined ? {} : { statusUrl: raw.statusUrl }),
    ...(raw.hideReason === undefined ? {} : { hideReason: raw.hideReason }),
  };
}

/** Turns a validated channel into its config; this is the separate secret step. */
function resolveChannel(raw: RawChannel, source: SecretSource): ChannelConfig {
  const base = baseOf(raw);
  switch (raw.type) {
    case "webhook": {
      const secret = readSecret(
        { env: raw.secretEnv, file: raw.secretFile },
        raw.id,
        "secret",
        source,
      );
      return {
        ...base,
        type: "webhook",
        url: raw.url,
        ...(secret === undefined ? {} : { secret }),
      };
    }
    case "file":
      return { ...base, type: "file", path: raw.path };
    case "slack":
    case "teams":
      return {
        ...base,
        type: raw.type,
        url: resolveChatUrl(raw, raw.id, source),
        ...messageOptionsOf(raw),
      };
    case "email": {
      const smtp = resolveSmtp(raw.smtp, raw.id, source);
      return {
        ...base,
        type: "email",
        smtp,
        from: raw.from,
        to: raw.to,
        ...(raw.subjectPrefix === undefined ? {} : { subjectPrefix: raw.subjectPrefix }),
        ...messageOptionsOf(raw),
      };
    }
    default: {
      const never: never = raw;
      return never;
    }
  }
}

/** The first issue as one line; unknown keys name the file and the place. */
function formatIssue(issue: z.core.$ZodIssue, file: string, prefix: string, id?: string): string {
  if (issue.code === "unrecognized_keys") {
    const place = [prefix, ...issue.path.map(String)].join(".");
    return `${file}: unknown key ${JSON.stringify(issue.keys[0])} in ${place}`;
  }
  return id === undefined ? issue.message : `channel "${id}": ${issue.message}`;
}

function parseChannel(
  raw: unknown,
  index: number,
  file: string,
  source: SecretSource,
): ChannelConfig {
  const where = `channels[${index}]`;
  if (!isObject(raw)) throw new ConfigError(`${where} must be an object`);
  const { id, type } = raw;
  if (typeof id !== "string" || id === "") {
    throw new ConfigError(`${where}.id must be a non-empty string`);
  }
  const schema = channelSchema(type);
  if (schema === undefined) {
    throw new ConfigError(`channel "${id}": unknown type ${JSON.stringify(type)}`);
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const [issue] = result.error.issues;
    throw new ConfigError(
      issue === undefined ? `${where}: invalid channel` : formatIssue(issue, file, where, id),
    );
  }
  return resolveChannel(result.data, source);
}

const configSchema = z.strictObject(
  {
    channels: z
      .array(z.unknown(), "config.channels must be a non-empty array")
      .min(1, "config.channels must be a non-empty array"),
  },
  "config must be an object",
);

/** `path` names the file in unknown-key errors. Secrets are read from `source` right here. */
export function parseConfig(
  raw: unknown,
  path = "config",
  source: SecretSource = realSource(),
): Config {
  const top = configSchema.safeParse(raw);
  if (!top.success) {
    const issue =
      top.error.issues.find((i) => i.code === "unrecognized_keys") ?? top.error.issues[0];
    throw new ConfigError(
      issue === undefined ? "config must be an object" : formatIssue(issue, path, "config"),
    );
  }
  const channels = top.data.channels.map((c, i) => parseChannel(c, i, path, source));
  const seen = new Set<string>();
  for (const channel of channels) {
    if (seen.has(channel.id)) throw new ConfigError(`duplicate channel id "${channel.id}"`);
    seen.add(channel.id);
  }
  return { channels };
}

export function loadConfigFile(path: string, source?: SecretSource): Config {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError(`cannot read config file ${path}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`config file ${path} is not valid JSON: ${(err as Error).message}`);
  }
  return parseConfig(json, path, source);
}

export interface Settings {
  configPath: string;
  apiUrl: string;
  statePath: string;
  pollMs: number;
  retryDelayMs: number;
  retryMaxDelayMs: number;
  retryAttempts: number;
  timeoutMs: number;
  logLevel: LogLevel;
  /** `undefined` means no health listener. */
  healthPort: number | undefined;
  healthHost: string;
  /** `/healthz` fails after this many failed polls in a row. */
  healthMaxFailedPolls: number;
  lockLeaseSeconds: number;
  stateRetentionDays: number;
  apiMaxBytes: number;
  /** Global EHLO name; `undefined` means the machine host name. */
  smtpClientName: string | undefined;
}

/** An integer setting with a lower bound; the message keeps the "at least" wording. */
function readMin(env: Env, name: string, fallback: number, min: number): number {
  return readMs(env, name, { fallback, min, describe: `must be an integer of at least ${min}` });
}

/** The API url must be http(s); the error never repeats it, it can hold credentials. */
function parseApiUrl(env: Env): string {
  const url = readUrl(env, "PULSE_API_URL", {
    allowCredentials: true,
    allowQueryOrFragment: true,
    describe: "must be a valid http(s) url",
  });
  return url ?? "http://localhost:3000";
}

function parseSmtpClientName(env: Env): string | undefined {
  const name = "PULSE_NOTIFY_SMTP_CLIENT_NAME";
  const value = readString(env, name);
  if (value === undefined) return undefined;
  if (!isEhloName(value)) {
    throw new StartupError(`${name}: must be a host name or an address literal`, { setting: name });
  }
  return value;
}

export function loadLockLeaseSeconds(env: Env): number {
  return readMin(env, "PULSE_NOTIFY_LOCK_LEASE_SECONDS", DEFAULT_LEASE_SECONDS, MIN_LEASE_SECONDS);
}

export function loadSettings(env: Env): Settings {
  const configPath = readString(env, "PULSE_NOTIFY_CONFIG");
  if (configPath === undefined) {
    throw new StartupError("PULSE_NOTIFY_CONFIG is required", { setting: "PULSE_NOTIFY_CONFIG" });
  }
  const pollMs = readMin(env, "PULSE_NOTIFY_POLL_MS", 5000, 1);
  const timeoutMs = readMin(env, "PULSE_NOTIFY_TIMEOUT_MS", 5000, 1);
  const retryDelayMs = readMs(env, "PULSE_NOTIFY_RETRY_DELAY_MS", {
    fallback: DEFAULT_RETRY_DELAY_MS,
    min: 0,
  });
  const retryMaxDelayMs = readMs(env, "PULSE_NOTIFY_RETRY_MAX_DELAY_MS", {
    fallback: DEFAULT_RETRY_MAX_DELAY_MS,
    min: 0,
  });
  if (retryMaxDelayMs < retryDelayMs) {
    throw new StartupError(
      "PULSE_NOTIFY_RETRY_MAX_DELAY_MS: must be at least PULSE_NOTIFY_RETRY_DELAY_MS",
      { setting: "PULSE_NOTIFY_RETRY_MAX_DELAY_MS" },
    );
  }
  return {
    configPath,
    apiUrl: parseApiUrl(env),
    statePath: readString(env, "PULSE_NOTIFY_STATE") ?? "./notify-state.json",
    pollMs,
    retryDelayMs,
    retryMaxDelayMs,
    retryAttempts: readMs(env, "PULSE_NOTIFY_RETRY_ATTEMPTS", {
      fallback: DEFAULT_RETRY_ATTEMPTS,
      min: 0,
    }),
    timeoutMs,
    logLevel: readLogLevel(env),
    healthPort: readPort(env, "PULSE_HEALTH_PORT"),
    healthHost: readString(env, "PULSE_HEALTH_HOST") ?? "127.0.0.1",
    healthMaxFailedPolls: readMin(env, "PULSE_NOTIFY_HEALTH_MAX_FAILED_POLLS", 5, 1),
    lockLeaseSeconds: loadLockLeaseSeconds(env),
    stateRetentionDays: readMin(env, "PULSE_NOTIFY_STATE_RETENTION_DAYS", 30, 1),
    apiMaxBytes: readMin(env, "PULSE_NOTIFY_API_MAX_BYTES", DEFAULT_API_MAX_BYTES, 1),
    smtpClientName: parseSmtpClientName(env),
  };
}
