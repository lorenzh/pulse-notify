import { readFileSync } from "node:fs";
import { envelopeAddress } from "./channels/email.ts";
import { isLoopbackHost } from "./channels/loopback.ts";
import {
  DEFAULT_RETRY_ATTEMPTS,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_RETRY_MAX_DELAY_MS,
} from "./delivery.ts";
import { LOG_LEVELS, type LogLevel } from "./log.ts";
import type { ChannelConfig, Config, SmtpConfig } from "./types.ts";

export class ConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
  raw: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  where: string,
): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      throw new ConfigError(`${path}: unknown key ${JSON.stringify(key)} in ${where}`);
    }
  }
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

function parseCheckList(
  raw: Record<string, unknown>,
  key: string,
  id: string,
): string[] | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((c) => typeof c === "string")) {
    throw new ConfigError(`channel "${id}": ${key} must be an array of strings`);
  }
  return value as string[];
}

function isHttpUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    // An unparseable URL is simply not an HTTP URL.
    return false;
  }
}

function parseRemind(value: unknown, id: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 60) {
    throw new ConfigError(`channel "${id}": remindEverySeconds must be an integer of at least 60`);
  }
  return value;
}

/** The common keys of every channel; absent keys stay absent. */
function parseBase(raw: Record<string, unknown>, id: string): ChannelBase {
  const base: ChannelBase = { id };
  const checks = parseCheckList(raw, "checks", id);
  if (checks !== undefined) base.checks = checks;
  const excludeChecks = parseCheckList(raw, "excludeChecks", id);
  if (excludeChecks !== undefined) base.excludeChecks = excludeChecks;
  const remind = parseRemind(raw.remindEverySeconds, id);
  if (remind !== undefined) base.remindEverySeconds = remind;
  return base;
}

type ChannelBase = Pick<ChannelConfig, "id" | "checks" | "excludeChecks" | "remindEverySeconds">;

const BASE_KEYS = ["id", "type", "checks", "excludeChecks", "remindEverySeconds"] as const;

function trimTrailingNewlines(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === "\n" || text[end - 1] === "\r")) end--;
  return text.slice(0, end);
}

/**
 * Reads a secret from `<name>Env` or `<name>File`. Errors name the channel and the key,
 * never the value. A file loses one trailing newline.
 */
function readSecret(
  raw: Record<string, unknown>,
  id: string,
  name: string,
  source: SecretSource,
): string | undefined {
  const envKey = `${name}Env`;
  const fileKey = `${name}File`;
  const envName = raw[envKey];
  const filePath = raw[fileKey];
  if (envName === undefined && filePath === undefined) return undefined;
  if (envName !== undefined && filePath !== undefined) {
    throw new ConfigError(`channel "${id}": set only one of ${envKey} and ${fileKey}`);
  }
  const key = envName === undefined ? fileKey : envKey;
  const ref = envName ?? filePath;
  if (typeof ref !== "string" || ref === "") {
    throw new ConfigError(`channel "${id}": ${key} must be a non-empty string`);
  }
  let value: string | undefined;
  if (envName === undefined) {
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

function requireSecret(
  raw: Record<string, unknown>,
  id: string,
  name: string,
  source: SecretSource,
): string {
  const value = readSecret(raw, id, name, source);
  if (value === undefined) {
    throw new ConfigError(`channel "${id}": ${name}Env or ${name}File is required`);
  }
  return value;
}

function parseStatusUrl(raw: Record<string, unknown>, id: string): string | undefined {
  if (raw.statusUrl === undefined) return undefined;
  if (!isHttpUrl(raw.statusUrl)) {
    throw new ConfigError(`channel "${id}": statusUrl must be a valid http(s) url`);
  }
  return raw.statusUrl;
}

function parseHideReason(raw: Record<string, unknown>, id: string): boolean | undefined {
  if (raw.hideReason === undefined) return undefined;
  if (typeof raw.hideReason !== "boolean") {
    throw new ConfigError(`channel "${id}": hideReason must be true or false`);
  }
  return raw.hideReason;
}

/** The keys that chat and email channels share. */
function parseMessageOptions(
  raw: Record<string, unknown>,
  id: string,
): { statusUrl?: string; hideReason?: boolean } {
  const out: { statusUrl?: string; hideReason?: boolean } = {};
  const statusUrl = parseStatusUrl(raw, id);
  if (statusUrl !== undefined) out.statusUrl = statusUrl;
  const hideReason = parseHideReason(raw, id);
  if (hideReason !== undefined) out.hideReason = hideReason;
  return out;
}

function parseWebhook(
  raw: Record<string, unknown>,
  base: ChannelBase,
  path: string,
  where: string,
  source: SecretSource,
): ChannelConfig {
  rejectUnknownKeys(raw, [...BASE_KEYS, "url", "secretEnv", "secretFile"], path, where);
  if (!isHttpUrl(raw.url)) {
    throw new ConfigError(`channel "${base.id}": webhook needs a valid http(s) url`);
  }
  const secret = readSecret(raw, base.id, "secret", source);
  return { ...base, type: "webhook", url: raw.url, ...(secret === undefined ? {} : { secret }) };
}

function parseFile(
  raw: Record<string, unknown>,
  base: ChannelBase,
  path: string,
  where: string,
): ChannelConfig {
  rejectUnknownKeys(raw, [...BASE_KEYS, "path"], path, where);
  if (typeof raw.path !== "string" || raw.path === "") {
    throw new ConfigError(`channel "${base.id}": file channel needs a path`);
  }
  return { ...base, type: "file", path: raw.path };
}

/** Slack and Teams URLs are credentials: https only, except for a local test server. */
function parseChatUrl(raw: Record<string, unknown>, id: string, source: SecretSource): string {
  const url = requireSecret(raw, id, "url", source);
  const key = raw.urlEnv === undefined ? "urlFile" : "urlEnv";
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

function parseChat(
  raw: Record<string, unknown>,
  base: ChannelBase,
  type: "slack" | "teams",
  path: string,
  where: string,
  source: SecretSource,
): ChannelConfig {
  rejectUnknownKeys(
    raw,
    [...BASE_KEYS, "urlEnv", "urlFile", "statusUrl", "hideReason"],
    path,
    where,
  );
  const url = parseChatUrl(raw, base.id, source);
  return { ...base, type, url, ...parseMessageOptions(raw, base.id) };
}

function parseAddress(value: unknown, id: string, key: string): string {
  if (typeof value !== "string" || value.trim() === "" || /[\r\n]/.test(value)) {
    throw new ConfigError(`channel "${id}": ${key} must be a single-line address`);
  }
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(envelopeAddress(value))) {
    throw new ConfigError(`channel "${id}": ${key} must hold an email address`);
  }
  return value;
}

function parseRecipients(value: unknown, id: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigError(`channel "${id}": to must be a non-empty array of addresses`);
  }
  return value.map((v) => parseAddress(v, id, "to"));
}

function parseSmtpTls(value: unknown, id: string): SmtpConfig["tls"] {
  if (value === undefined) return "starttls";
  if (value === "starttls" || value === "tls" || value === "none") return value;
  throw new ConfigError(`channel "${id}": smtp.tls must be "starttls", "tls" or "none"`);
}

function parseSmtp(value: unknown, id: string, path: string, source: SecretSource): SmtpConfig {
  if (!isObject(value)) throw new ConfigError(`channel "${id}": smtp must be an object`);
  const where = "smtp";
  rejectUnknownKeys(
    value,
    ["host", "port", "tls", "username", "passwordEnv", "passwordFile"],
    path,
    `channels ${JSON.stringify(id)} ${where}`,
  );
  if (typeof value.host !== "string" || value.host === "" || /\s/.test(value.host)) {
    throw new ConfigError(`channel "${id}": smtp.host must be a host name`);
  }
  const { port } = value;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`channel "${id}": smtp.port must be an integer from 1 to 65535`);
  }
  const tls = parseSmtpTls(value.tls, id);
  const smtp: SmtpConfig = { host: value.host, port, tls };
  if (value.username === undefined) {
    if (value.passwordEnv !== undefined || value.passwordFile !== undefined) {
      throw new ConfigError(`channel "${id}": smtp password needs a username`);
    }
    return smtp;
  }
  if (
    typeof value.username !== "string" ||
    value.username === "" ||
    /[\r\n]/.test(value.username)
  ) {
    throw new ConfigError(`channel "${id}": smtp.username must be a single-line string`);
  }
  if (tls === "none" && !isLoopbackHost(value.host)) {
    throw new ConfigError(
      `channel "${id}": smtp login is refused with tls "none" on a remote host`,
    );
  }
  smtp.username = value.username;
  smtp.password = requireSecret(value, id, "password", source);
  return smtp;
}

function parseEmail(
  raw: Record<string, unknown>,
  base: ChannelBase,
  path: string,
  where: string,
  source: SecretSource,
): ChannelConfig {
  rejectUnknownKeys(
    raw,
    [...BASE_KEYS, "smtp", "from", "to", "subjectPrefix", "statusUrl", "hideReason"],
    path,
    where,
  );
  const smtp = parseSmtp(raw.smtp, base.id, path, source);
  const from = parseAddress(raw.from, base.id, "from");
  const to = parseRecipients(raw.to, base.id);
  const out: ChannelConfig = { ...base, type: "email", smtp, from, to };
  if (raw.subjectPrefix !== undefined) {
    if (typeof raw.subjectPrefix !== "string" || /[\r\n]/.test(raw.subjectPrefix)) {
      throw new ConfigError(`channel "${base.id}": subjectPrefix must be a single-line string`);
    }
    out.subjectPrefix = raw.subjectPrefix;
  }
  return { ...out, ...parseMessageOptions(raw, base.id) };
}

function parseChannel(
  raw: unknown,
  index: number,
  path: string,
  source: SecretSource,
): ChannelConfig {
  const where = `channels[${index}]`;
  if (!isObject(raw)) throw new ConfigError(`${where} must be an object`);
  const { id, type } = raw;
  if (typeof id !== "string" || id === "") {
    throw new ConfigError(`${where}.id must be a non-empty string`);
  }
  const base = parseBase(raw, id);
  switch (type) {
    case "webhook":
      return parseWebhook(raw, base, path, where, source);
    case "file":
      return parseFile(raw, base, path, where);
    case "slack":
    case "teams":
      return parseChat(raw, base, type, path, where, source);
    case "email":
      return parseEmail(raw, base, path, where, source);
    default:
      throw new ConfigError(`channel "${id}": unknown type ${JSON.stringify(type)}`);
  }
}

/** `path` names the file in unknown-key errors. Secrets are read from `source` right here. */
export function parseConfig(
  raw: unknown,
  path = "config",
  source: SecretSource = realSource(),
): Config {
  if (!isObject(raw)) throw new ConfigError("config must be an object");
  rejectUnknownKeys(raw, ["channels"], path, "config");
  if (!Array.isArray(raw.channels) || raw.channels.length === 0) {
    throw new ConfigError("config.channels must be a non-empty array");
  }
  const channels = raw.channels.map((c, i) => parseChannel(c, i, path, source));
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
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (value === undefined || value === "") return "info";
  const level = LOG_LEVELS.find((l) => l === value);
  if (level === undefined) {
    throw new ConfigError(`PULSE_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}`);
  }
  return level;
}

function parseHealthPort(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new ConfigError("PULSE_HEALTH_PORT must be an integer from 0 to 65535");
  }
  return n;
}

function intEnv(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const value = env[name];
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new ConfigError(`${name} must be a non-negative integer`);
  }
  return n;
}

export function loadSettings(env: Record<string, string | undefined>): Settings {
  const configPath = env.PULSE_NOTIFY_CONFIG;
  if (!configPath) throw new ConfigError("PULSE_NOTIFY_CONFIG is required");
  const pollMs = intEnv(env, "PULSE_NOTIFY_POLL_MS", 5000);
  const timeoutMs = intEnv(env, "PULSE_NOTIFY_TIMEOUT_MS", 5000);
  if (pollMs < 1) throw new ConfigError("PULSE_NOTIFY_POLL_MS must be at least 1");
  if (timeoutMs < 1) throw new ConfigError("PULSE_NOTIFY_TIMEOUT_MS must be at least 1");
  const retryDelayMs = intEnv(env, "PULSE_NOTIFY_RETRY_DELAY_MS", DEFAULT_RETRY_DELAY_MS);
  const retryMaxDelayMs = intEnv(
    env,
    "PULSE_NOTIFY_RETRY_MAX_DELAY_MS",
    DEFAULT_RETRY_MAX_DELAY_MS,
  );
  if (retryMaxDelayMs < retryDelayMs) {
    throw new ConfigError(
      "PULSE_NOTIFY_RETRY_MAX_DELAY_MS must be at least PULSE_NOTIFY_RETRY_DELAY_MS",
    );
  }
  return {
    configPath,
    apiUrl: env.PULSE_API_URL || "http://localhost:3000",
    statePath: env.PULSE_NOTIFY_STATE || "./notify-state.json",
    pollMs,
    retryDelayMs,
    retryMaxDelayMs,
    retryAttempts: intEnv(env, "PULSE_NOTIFY_RETRY_ATTEMPTS", DEFAULT_RETRY_ATTEMPTS),
    timeoutMs,
    logLevel: parseLogLevel(env.PULSE_LOG_LEVEL),
    healthPort: parseHealthPort(env.PULSE_HEALTH_PORT),
    healthHost: env.PULSE_HEALTH_HOST || "127.0.0.1",
  };
}
