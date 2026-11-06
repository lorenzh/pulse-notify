import { join, sep } from "node:path";
import {
  NOTIFY_SECRET_ENV_PREFIX,
  type NotifyChannelRecord,
  type NotifyRejectedChannel,
  validateNotifyChannelRecord,
  validateServiceNotifyChannels,
} from "@lorenzh/pulse-contract";
import type { Env } from "@lorenzh/pulse-kit";
import type { RawChannel } from "./channel-schema.ts";
import { ConfigError, resolveChannel } from "./config.ts";
import type { ChannelConfig } from "./types.ts";

/** Longest `reason` of a rejected channel in a report (R1 cut rule). */
const REASON_MAX = 300;

/**
 * Cuts `text` to at most `max` UTF-16 code units, the last one `…`, and never splits a surrogate
 * pair (R1 cut rule).
 */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)}…`;
}

function rejection(channelId: string | null, reason: string): NotifyRejectedChannel {
  return { channelId, reason: cutText(reason, REASON_MAX) };
}

/**
 * The two levels of Decision 6 for `GET /service/notify/channels`.
 * - `envelope`: the whole answer is refused; nothing may change (set, ETag, rows, revision).
 * - `applied`: the envelope holds; `records` are the valid elements in answer order and
 *   `rejected` names each invalid one by its id. An invalid id keeps its last good version.
 */
export type ChannelsAnswer =
  | { kind: "envelope"; rejected: NotifyRejectedChannel }
  | {
      kind: "applied";
      revision: string;
      records: NotifyChannelRecord[];
      rejected: NotifyRejectedChannel[];
    };

/** The validator text with its empty root path removed. */
function envelopeReason(error: string): string {
  return `channels answer: ${error.replace(/^(: |\.)/, "")}`;
}

/** Checks the envelope first and each element only after it holds. Never throws. */
export function checkChannelsAnswer(raw: unknown): ChannelsAnswer {
  const envelope = validateServiceNotifyChannels(raw, "");
  if (!envelope.ok) {
    return { kind: "envelope", rejected: rejection(null, envelopeReason(envelope.error)) };
  }
  const records: NotifyChannelRecord[] = [];
  const rejected: NotifyRejectedChannel[] = [];
  envelope.value.channels.forEach((element, i) => {
    const record = validateNotifyChannelRecord(element, `channels[${i}]`);
    if (record.ok) records.push(record.value);
    else rejected.push(rejection(element.id, record.error));
  });
  return { kind: "applied", revision: envelope.value.revision, records, rejected };
}

/** JSON with the keys of every object sorted, so equal definitions give equal text. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort((a, b) => (a < b ? -1 : Number(a > b)))) {
    out[key] = canonical((value as Record<string, unknown>)[key]);
  }
  return out;
}

/** The canonical JSON of a record's definition: without `createdAt` and `updatedAt`. */
export function canonicalDefinition(record: NotifyChannelRecord): string {
  return JSON.stringify(canonical(definitionOf(record)));
}

type Definition = DistributiveOmit<NotifyChannelRecord, "createdAt" | "updatedAt">;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** The record without its timestamps. */
function definitionOf(record: NotifyChannelRecord): Definition {
  const copy: Partial<NotifyChannelRecord> = { ...record };
  delete copy.createdAt;
  delete copy.updatedAt;
  // Only the two timestamps were removed from a validated record.
  return copy as Definition;
}

/** Where notify resolves the references of a database channel; injected for tests. */
export interface SecretContext {
  env: Env;
  /** `PULSE_NOTIFY_SECRET_DIR`; `undefined` refuses every file reference. */
  secretDir: string | undefined;
  realpath: (path: string) => string;
  readFile: (path: string) => string;
}

export type ResolvedChannel =
  | { ok: true; config: ChannelConfig }
  | { ok: false; rejected: NotifyRejectedChannel };

function fileRefs(record: NotifyChannelRecord): [string, string][] {
  const refs: [string, string | undefined][] =
    record.type === "email"
      ? [["smtp.passwordFile", record.smtp.passwordFile]]
      : [["urlFile", record.urlFile]];
  if (record.type === "webhook") refs.push(["secretFile", record.secretFile]);
  return refs.filter((r): r is [string, string] => r[1] !== undefined);
}

/**
 * The real path of a file reference inside the secret directory. A reference is a basename
 * (the contract checks it); a symlink that leaves the directory is refused.
 */
function secretPath(ref: string, key: string, id: string, ctx: SecretContext): string {
  if (ctx.secretDir === undefined) {
    throw new ConfigError(`channel "${id}": secret files are not enabled`);
  }
  let root: string;
  let target: string;
  try {
    root = ctx.realpath(ctx.secretDir);
    target = ctx.realpath(join(root, ref));
  } catch (err) {
    throw new ConfigError(`channel "${id}": ${key}: cannot read file ${ref}`, { cause: err });
  }
  if (!target.startsWith(`${root}${sep}`)) {
    throw new ConfigError(`channel "${id}": ${key}: ${ref} is outside the secret directory`);
  }
  return target;
}

/** Only `PULSE_NOTIFY_SECRET_*` names are visible to a database channel. */
function allowedEnv(env: Env): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith(NOTIFY_SECRET_ENV_PREFIX)) out[name] = value;
  }
  return out;
}

/** The record as the channel shape of the file, which the shared secret step reads. */
function rawOf(record: NotifyChannelRecord): RawChannel {
  const definition = definitionOf(record);
  if (definition.type === "email") {
    return { ...definition, smtp: { ...definition.smtp, tls: definition.smtp.tls ?? "starttls" } };
  }
  return definition;
}

/**
 * Resolves the references of one valid database channel with the notify-local rules. A
 * failure names the channel and the reference, never a secret value.
 */
export function resolveDatabaseChannel(
  record: NotifyChannelRecord,
  ctx: SecretContext,
): ResolvedChannel {
  try {
    const paths = new Map<string, string>();
    for (const [key, ref] of fileRefs(record)) {
      paths.set(ref, secretPath(ref, key, record.id, ctx));
    }
    const config = resolveChannel(rawOf(record), {
      env: allowedEnv(ctx.env),
      readFile: (ref) => {
        const path = paths.get(ref);
        if (path === undefined) throw new ConfigError("unknown secret file reference");
        return ctx.readFile(path);
      },
    });
    return { ok: true, config };
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return { ok: false, rejected: rejection(record.id, err.message) };
  }
}
