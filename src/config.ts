import { readFileSync } from "node:fs";
import {
  DEFAULT_RETRY_ATTEMPTS,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_RETRY_MAX_DELAY_MS,
} from "./delivery.ts";
import { LOG_LEVELS, type LogLevel } from "./log.ts";
import type { ChannelConfig, Config } from "./types.ts";

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

function parseChecks(value: unknown, id: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((c) => typeof c === "string")) {
    throw new ConfigError(`channel "${id}": checks must be an array of strings`);
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

function parseChannel(raw: unknown, index: number, path: string): ChannelConfig {
  const where = `channels[${index}]`;
  if (!isObject(raw)) throw new ConfigError(`${where} must be an object`);
  const { id, type } = raw;
  if (typeof id !== "string" || id === "") {
    throw new ConfigError(`${where}.id must be a non-empty string`);
  }
  const checks = parseChecks(raw.checks, id);
  const base = checks === undefined ? { id } : { id, checks };
  if (type === "webhook") {
    rejectUnknownKeys(raw, ["id", "type", "checks", "url"], path, where);
    if (!isHttpUrl(raw.url))
      throw new ConfigError(`channel "${id}": webhook needs a valid http(s) url`);
    return { ...base, type: "webhook", url: raw.url };
  }
  if (type === "file") {
    rejectUnknownKeys(raw, ["id", "type", "checks", "path"], path, where);
    if (typeof raw.path !== "string" || raw.path === "") {
      throw new ConfigError(`channel "${id}": file channel needs a path`);
    }
    return { ...base, type: "file", path: raw.path };
  }
  throw new ConfigError(`channel "${id}": unknown type ${JSON.stringify(type)}`);
}

/** `path` names the file in unknown-key errors. */
export function parseConfig(raw: unknown, path = "config"): Config {
  if (!isObject(raw)) throw new ConfigError("config must be an object");
  rejectUnknownKeys(raw, ["channels"], path, "config");
  if (!Array.isArray(raw.channels) || raw.channels.length === 0) {
    throw new ConfigError("config.channels must be a non-empty array");
  }
  const channels = raw.channels.map((c, i) => parseChannel(c, i, path));
  const seen = new Set<string>();
  for (const channel of channels) {
    if (seen.has(channel.id)) throw new ConfigError(`duplicate channel id "${channel.id}"`);
    seen.add(channel.id);
  }
  return { channels };
}

export function loadConfigFile(path: string): Config {
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
  return parseConfig(json, path);
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
