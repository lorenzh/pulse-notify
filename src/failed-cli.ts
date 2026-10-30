import type { FailedEntry, Ledger } from "./ledger.ts";

export interface CliResult {
  lines: string[];
  /** 0 on success, 1 on a refused or failed request. Exit 2 (state in use) is decided by the caller. */
  code: number;
}

const USAGE = [
  "usage: pulse-notify failed list",
  "       pulse-notify failed resend <key> [--channel <id>]",
  "       pulse-notify failed resend --all [--channel <id>]",
];

/** The event of an entry: from its notification, else from its key (`12:opened`). */
function eventOf(entry: FailedEntry): string {
  if (entry.notification) return entry.notification.event;
  const parts = entry.key.split(":");
  return (parts[0] === "manual" ? parts[2] : parts[1]) ?? "unknown";
}

function describe(entry: FailedEntry): string {
  const payload = entry.notification ? "payload" : "no payload";
  return [
    entry.channelId,
    entry.key,
    new Date(entry.at).toISOString(),
    eventOf(entry),
    payload,
  ].join("\t");
}

interface ResendArgs {
  key: string | undefined;
  isAll: boolean;
  channel: string | undefined;
}

/** Parses the arguments after `resend`; `undefined` when they do not fit the usage. */
function parseResendArgs(args: string[]): ResendArgs | undefined {
  const parsed: ResendArgs = { key: undefined, isAll: false, channel: undefined };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--all") {
      parsed.isAll = true;
    } else if (arg === "--channel") {
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) return undefined;
      parsed.channel = value;
    } else if (arg !== undefined && !arg.startsWith("--") && parsed.key === undefined) {
      parsed.key = arg;
    } else {
      return undefined;
    }
  }
  return parsed.isAll === (parsed.key === undefined) ? parsed : undefined;
}

function list(ledger: Ledger): CliResult {
  const entries = ledger.failed();
  if (entries.length === 0) return { lines: ["no failed notifications"], code: 0 };
  return { lines: entries.map(describe), code: 0 };
}

function resend(ledger: Ledger, args: string[]): CliResult {
  const parsed = parseResendArgs(args);
  if (!parsed) return { lines: USAGE, code: 1 };
  const matches = ledger
    .failed()
    .filter((e) => (parsed.isAll || e.key === parsed.key) && matchesChannel(e, parsed.channel));
  if (matches.length === 0) {
    if (parsed.isAll) return { lines: ["no failed notifications to resend"], code: 0 };
    return { lines: [`no failed notification with key ${parsed.key}`], code: 1 };
  }
  const lines: string[] = [];
  let hasSkipped = false;
  for (const entry of matches) {
    if (ledger.resend(entry.channelId, entry.key) === "resent") {
      lines.push(`resent ${entry.channelId} ${entry.key}`);
    } else {
      hasSkipped = true;
      lines.push(`skipped ${entry.channelId} ${entry.key}: no payload stored, it cannot be resent`);
    }
  }
  lines.push("the service sends resent notifications at its next start");
  return { lines, code: hasSkipped ? 1 : 0 };
}

function matchesChannel(entry: FailedEntry, channel: string | undefined): boolean {
  return channel === undefined || entry.channelId === channel;
}

/**
 * Runs `failed list` or `failed resend ...` (the arguments after `failed`) on a ledger.
 * Changes are written by `resend` at once. The caller holds the state lock.
 */
export function runFailed(args: string[], ledger: Ledger): CliResult {
  const [command, ...rest] = args;
  if (command === "list" && rest.length === 0) return list(ledger);
  if (command === "resend") return resend(ledger, rest);
  return { lines: USAGE, code: 1 };
}
