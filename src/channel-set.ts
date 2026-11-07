import { createHash } from "node:crypto";
import type { ChannelConfig } from "./types.ts";

/** One resolved channel and the digest of its resolved form (secrets included, hashed). */
export interface InstalledChannel {
  config: ChannelConfig;
  digest: string;
}

export interface EffectiveSet {
  /** File channels in file order, then unshadowed database channels in answer order. */
  channels: InstalledChannel[];
  /** Database ids whose whole channel a file channel replaces. */
  shadowedIds: string[];
}

export type ChannelChange =
  | { kind: "added"; id: string; next: InstalledChannel }
  | { kind: "changed"; id: string; previous: InstalledChannel; next: InstalledChannel }
  | { kind: "removed"; id: string; previous: InstalledChannel }
  | { kind: "unchanged"; id: string; previous: InstalledChannel };

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort((a, b) => (a < b ? -1 : Number(a > b)))) {
    out[key] = sorted((value as Record<string, unknown>)[key]);
  }
  return out;
}

/** SHA-256 of the canonical JSON of a resolved channel; equal channels give equal digests. */
export function channelDigest(config: ChannelConfig): string {
  return createHash("sha256")
    .update(JSON.stringify(sorted(config)))
    .digest("hex");
}

/** Wraps a resolved channel with its digest. */
export function installedChannel(config: ChannelConfig): InstalledChannel {
  return { config, digest: channelDigest(config) };
}

/** Decision 13: a file channel wins by whole id; its database copy is kept out and shadowed. */
export function effectiveSet(
  file: readonly InstalledChannel[],
  database: readonly InstalledChannel[],
): EffectiveSet {
  const fileIds = new Set(file.map((c) => c.config.id));
  const channels = [...file];
  const shadowedIds: string[] = [];
  for (const channel of database) {
    if (fileIds.has(channel.config.id)) shadowedIds.push(channel.config.id);
    else channels.push(channel);
  }
  return { channels, shadowedIds };
}

/** The per-id change from the installed set to the next set, in next order then removals. */
export function channelChanges(
  installed: readonly InstalledChannel[],
  next: readonly InstalledChannel[],
): ChannelChange[] {
  const before = new Map(installed.map((c) => [c.config.id, c]));
  const changes: ChannelChange[] = [];
  for (const channel of next) {
    const id = channel.config.id;
    const previous = before.get(id);
    before.delete(id);
    if (previous === undefined) changes.push({ kind: "added", id, next: channel });
    else if (previous.digest === channel.digest) changes.push({ kind: "unchanged", id, previous });
    else changes.push({ kind: "changed", id, previous, next: channel });
  }
  for (const [id, previous] of before) changes.push({ kind: "removed", id, previous });
  return changes;
}
