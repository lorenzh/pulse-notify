import type {
  NotifyFailedDelivery,
  NotifyFailedEvent,
  NotifyFileChannelView,
  NotifyRejectedChannel,
  NotifyServiceReport,
} from "@lorenzh/pulse-contract";
import type { FailedEntry } from "./ledger.ts";
import { cutText } from "./remote-channels.ts";

const ID_MAX = 200;
const REF_MAX = 200;
const REASON_MAX = 300;
const KEY_MAX = 300;
const REFS_MAX = 6;
const FILE_VIEWS_MAX = 200;
const FAILED_MAX = 200;
const REJECTED_MAX = 100;
const SHADOWED_MAX = 100;
/** `SERVICE_REPORT_MAX_BYTES` of the contract (R1). */
const REPORT_MAX_BYTES = 524_288;

/** The reference names in the order of R1; never their values. */
const REF_ORDER = [
  ["urlEnv"],
  ["urlFile"],
  ["secretEnv"],
  ["secretFile"],
  ["smtp", "passwordEnv"],
  ["smtp", "passwordFile"],
] as const;

const RECOGNIZED: readonly NotifyFailedEvent[] = [
  "opened",
  "update",
  "resolved",
  "reminder",
  "budget-low",
  "tls-expiry",
  "domain-expiry",
];
const INCIDENT_EVENTS: readonly string[] = ["opened", "update", "resolved", "reminder"];

/** One file channel as notify read it: its id, type and raw (unresolved) definition. */
export interface FileChannelSource {
  id: string;
  type: NotifyFileChannelView["type"];
  raw: Readonly<Record<string, unknown>>;
}

export interface ReportInput {
  at: number;
  startedAt: number;
  appliedRevision: string | null;
  fileChannels: readonly FileChannelSource[];
  shadowedIds: readonly string[];
  rejected: readonly NotifyRejectedChannel[];
  failed: readonly FailedEntry[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refAt(raw: Readonly<Record<string, unknown>>, path: readonly string[]): unknown {
  let value: unknown = raw;
  for (const part of path) {
    if (!isRecord(value) || !Object.hasOwn(value, part)) return undefined;
    value = value[part];
  }
  return value;
}

/** The reference names of a file channel, cut for display; never used to resolve a secret. */
export function referenceNames(raw: Readonly<Record<string, unknown>>): string[] {
  const refs: string[] = [];
  for (const path of REF_ORDER) {
    const value = refAt(raw, path);
    if (typeof value === "string" && value.length > 0) refs.push(cutText(value, REF_MAX));
  }
  return refs.slice(0, REFS_MAX);
}

function eventOfKey(key: string): { event: NotifyFailedEvent; isManual: boolean } {
  const parts = key.split(":");
  const known = (e: string | undefined): NotifyFailedEvent =>
    e !== undefined && INCIDENT_EVENTS.includes(e) ? (e as NotifyFailedEvent) : "unknown";
  if (parts[0] === "manual" && parts.length >= 3) return { event: known(parts[2]), isManual: true };
  if (parts[0] === "budget" && parts.length >= 2) return { event: "budget-low", isManual: false };
  if (parts.length >= 2 && /^\d+$/.test(parts[0] ?? "")) {
    return { event: known(parts[1]), isManual: false };
  }
  return { event: "unknown", isManual: false };
}

/** The event of a failed entry: a recognized payload wins, else the key rules 2a-2d of R1. */
export function failedEvent(
  key: string,
  payload: unknown,
): { event: NotifyFailedEvent; isManual: boolean } {
  if (isRecord(payload)) {
    const event = Object.hasOwn(payload, "event") ? payload.event : undefined;
    const found = RECOGNIZED.find((e) => e === event);
    if (found !== undefined) {
      const manual = Object.hasOwn(payload, "manual") ? payload.manual : undefined;
      return { event: found, isManual: isRecord(manual) };
    }
  }
  return eventOfKey(key);
}

function failedView(entry: FailedEntry): NotifyFailedDelivery | undefined {
  if (entry.channelId.length > ID_MAX || entry.key.length > KEY_MAX) return undefined;
  const payload: unknown = entry.notification;
  return {
    channelId: entry.channelId,
    key: entry.key,
    ...failedEvent(entry.key, payload),
    failedAt: entry.at,
    hasPayload: payload !== undefined,
  };
}

function byteSize(report: NotifyServiceReport): number {
  return Buffer.byteLength(JSON.stringify(report), "utf8");
}

/** Leaves out entries from the end of `failed`, `fileChannels`, then `rejected` until it fits. */
function trimToSize(report: NotifyServiceReport): NotifyServiceReport {
  const out = {
    ...report,
    failed: [...report.failed],
    fileChannels: [...report.fileChannels],
    rejected: [...report.rejected],
  };
  const isOver = (): boolean => byteSize(out) > REPORT_MAX_BYTES;
  while (out.failed.length > 0 && isOver()) out.failed.pop();
  while (out.fileChannels.length > 0 && isOver()) out.fileChannels.pop();
  while (out.rejected.length > 0 && isOver()) out.rejected.pop();
  return out;
}

/** Builds the `NotifyServiceReport` of R1 from notify's state: cut, bounded, at most 524288 bytes. */
export function buildServiceReport(input: ReportInput): NotifyServiceReport {
  const failed = [...input.failed]
    .sort((a, b) => b.at - a.at)
    .map(failedView)
    .filter((v): v is NotifyFailedDelivery => v !== undefined);
  const report: NotifyServiceReport = {
    at: input.at,
    startedAt: input.startedAt,
    appliedRevision: input.appliedRevision,
    fileChannels: input.fileChannels.slice(0, FILE_VIEWS_MAX).map((c) => ({
      source: "file",
      id: cutText(c.id, ID_MAX),
      type: c.type,
      refs: referenceNames(c.raw),
    })),
    fileChannelsTotal: input.fileChannels.length,
    shadowedIds: input.shadowedIds.slice(0, SHADOWED_MAX),
    rejected: input.rejected.slice(0, REJECTED_MAX).map((r) => ({
      channelId: r.channelId === null ? null : cutText(r.channelId, ID_MAX),
      reason: cutText(r.reason, REASON_MAX),
    })),
    failed: failed.slice(0, FAILED_MAX),
    failedTotal: input.failed.length,
  };
  return trimToSize(report);
}
