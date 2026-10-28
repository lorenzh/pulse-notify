import { readFileSync } from "node:fs";
import type { ChannelConfig, Config } from "./types.ts";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseChannel(raw: unknown, index: number): ChannelConfig {
  const where = `channels[${index}]`;
  if (!isObject(raw)) throw new ConfigError(`${where} must be an object`);
  const { id, type } = raw;
  if (typeof id !== "string" || id === "") {
    throw new ConfigError(`${where}.id must be a non-empty string`);
  }
  let checks: string[] | undefined;
  if (raw.checks !== undefined) {
    if (!Array.isArray(raw.checks) || !raw.checks.every((c) => typeof c === "string")) {
      throw new ConfigError(`channel "${id}": checks must be an array of strings`);
    }
    checks = raw.checks as string[];
  }
  const base = checks === undefined ? { id } : { id, checks };
  if (type === "webhook") {
    const url = raw.url;
    let valid = false;
    if (typeof url === "string") {
      try {
        const protocol = new URL(url).protocol;
        valid = protocol === "http:" || protocol === "https:";
      } catch {
        valid = false;
      }
    }
    if (!valid) throw new ConfigError(`channel "${id}": webhook needs a valid http(s) url`);
    return { ...base, type: "webhook", url: url as string };
  }
  if (type === "file") {
    if (typeof raw.path !== "string" || raw.path === "") {
      throw new ConfigError(`channel "${id}": file channel needs a path`);
    }
    return { ...base, type: "file", path: raw.path };
  }
  throw new ConfigError(`channel "${id}": unknown type ${JSON.stringify(type)}`);
}

export function parseConfig(raw: unknown): Config {
  if (!isObject(raw)) throw new ConfigError("config must be an object");
  if (!Array.isArray(raw.channels) || raw.channels.length === 0) {
    throw new ConfigError("config.channels must be a non-empty array");
  }
  const channels = raw.channels.map(parseChannel);
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
  return parseConfig(json);
}

export interface Settings {
  configPath: string;
  apiUrl: string;
  statePath: string;
  pollMs: number;
  retryDelayMs: number;
  timeoutMs: number;
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
  return {
    configPath,
    apiUrl: env.PULSE_API_URL || "http://localhost:3000",
    statePath: env.PULSE_NOTIFY_STATE || "./notify-state.json",
    pollMs,
    retryDelayMs: intEnv(env, "PULSE_NOTIFY_RETRY_DELAY_MS", 1000),
    timeoutMs,
  };
}
