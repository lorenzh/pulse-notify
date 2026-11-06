import { createHash } from "node:crypto";
import {
  type NotifyChannelRecord,
  type NotifyRejectedChannel,
  validateNotifyChannelDefinition,
} from "@lorenzh/pulse-contract";
import type { Logger } from "@lorenzh/pulse-kit";
import { ApiReadError, type ServiceRead } from "./api.ts";
import { effectiveSet, type InstalledChannel, installedChannel } from "./channel-set.ts";
import { errorFields } from "./errors.ts";
import type { Ledger, RemoteChannelRow } from "./ledger.ts";
import {
  type ChannelsAnswer,
  canonicalDefinition,
  checkChannelsAnswer,
  resolveDatabaseChannel,
  type SecretContext,
} from "./remote-channels.ts";
import type { ChannelConfig, Schedule } from "./types.ts";

/** One applied database channel: its persisted row and its resolved form. */
interface RemoteEntry {
  row: RemoteChannelRow;
  channel: InstalledChannel;
}

export interface ChannelSyncOptions {
  ledger: Pick<Ledger, "remoteChannels" | "replaceRemoteChannels">;
  /** Installs the effective set; the poll never waits for the returned handovers. */
  install: (channels: readonly ChannelConfig[]) => Promise<void> | void;
  /** The channel file's text; `undefined` without a file. Throws when it cannot be read. */
  readFile?: (() => string) | undefined;
  /** Parses and resolves the file text; throws on an invalid file. */
  parseFile: (text: string) => readonly ChannelConfig[];
  /** `GET /service/notify/channels`; `undefined` without a token (no service call at all). */
  fetchChannels?: ((etag: string | undefined) => Promise<ServiceRead<unknown>>) | undefined;
  secrets: SecretContext;
  now: () => number;
  logger: Logger;
}

/** What the service report reads from the sync. */
export interface ChannelSyncState {
  /** The revision of the last applied valid envelope; `null` before one. */
  appliedRevision: string | null;
  rejected: NotifyRejectedChannel[];
  /** The installed file channels (last good file). */
  fileChannels: ChannelConfig[];
  /** Database ids that a file channel replaces. */
  shadowedIds: string[];
}

/** Fixed reasons for a refused whole answer; no answer text reaches the report. */
const ANSWER_FAILURES: ReadonlyMap<string, string> = new Map([
  ["too-large", "channels answer: larger than 1048576 bytes"],
  ["invalid-json", "channels answer: invalid JSON"],
  ["wire-mismatch", "channels answer: wire version mismatch"],
  ["validation", "channels answer: invalid answer"],
]);

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A stored definition as a record, so the shared resolver reads it; the stamps are unused. */
function storedRecord(row: RemoteChannelRow): NotifyChannelRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.definition);
  } catch {
    // The ledger checked every row at open; an unreadable one is skipped like an unknown id.
    return undefined;
  }
  const checked = validateNotifyChannelDefinition(parsed);
  if (!checked.ok) return undefined;
  const record = { ...checked.value, createdAt: 0, updatedAt: 0 };
  // The definition passed the contract validator; the two stamps complete the record shape.
  return record as NotifyChannelRecord;
}

/**
 * Keeps the effective channel set in step with the channel file and the database channels
 * (Decisions 6, 11-13 and 17). The file is re-read at every poll and reparsed only when its
 * SHA-256 changes; the database channels use the ETag. A bad file or envelope keeps the last good
 * state; after a valid envelope a bad element keeps only its own last good version.
 */
export class ChannelSync {
  readonly #opts: ChannelSyncOptions;
  #fileChannels: InstalledChannel[];
  #fileSha: string | undefined;
  #remote = new Map<string, RemoteEntry>();
  #etag: string | undefined;
  #appliedRevision: string | null = null;
  #rejected: NotifyRejectedChannel[] = [];
  /** The rejection of the channel file while its last good channels stay. */
  #fileRejected: NotifyRejectedChannel | undefined;
  #shadowedIds: string[] = [];
  #isOldApi = false;
  #cancel: (() => void) | undefined;
  #isRunning = false;
  #polling: Promise<void> | undefined;

  constructor(opts: ChannelSyncOptions, fileChannels: readonly ChannelConfig[] = []) {
    this.#opts = opts;
    this.#fileChannels = fileChannels.map(installedChannel);
  }

  /**
   * Cold start: resolves the last applied database channels from the ledger, so they work while
   * the api is down. A row that no longer resolves is left out and rejected.
   */
  restore(): ChannelConfig[] {
    // Tokenless mode has no database layer, so rows from an earlier token-mode run stay unused.
    if (this.#opts.fetchChannels === undefined) return this.#effective();
    for (const row of this.#opts.ledger.remoteChannels()) {
      const record = storedRecord(row);
      if (record === undefined) continue;
      const resolved = resolveDatabaseChannel(record, this.#opts.secrets);
      if (!resolved.ok) {
        this.#rejected.push(resolved.rejected);
        continue;
      }
      this.#remote.set(row.id, { row, channel: installedChannel(resolved.config) });
    }
    return this.#effective();
  }

  state(): ChannelSyncState {
    return {
      appliedRevision: this.#appliedRevision,
      rejected: [
        ...(this.#fileRejected ? [{ ...this.#fileRejected }] : []),
        ...this.#rejected.map((r) => ({ ...r })),
      ],
      fileChannels: this.#fileChannels.map((c) => c.config),
      shadowedIds: [...this.#shadowedIds],
    };
  }

  /** Polls at once and then every `intervalMs` until `stop`. */
  start(schedule: Schedule, intervalMs: number): void {
    if (this.#isRunning) return;
    this.#isRunning = true;
    const next = (ms: number): void => {
      if (!this.#isRunning) return;
      this.#cancel = schedule(() => {
        void this.poll().finally(() => next(intervalMs));
      }, ms);
    };
    next(0);
  }

  /** Stops the loop and waits for a poll in flight. */
  async stop(): Promise<void> {
    this.#isRunning = false;
    this.#cancel?.();
    this.#cancel = undefined;
    await this.#polling;
  }

  /** One file read and one channels read, then one install. Never rejects. */
  poll(): Promise<void> {
    this.#polling ??= this.#poll().finally(() => {
      this.#polling = undefined;
    });
    return this.#polling;
  }

  async #poll(): Promise<void> {
    this.#readFile();
    await this.#readRemote();
    const channels = this.#effective();
    try {
      void Promise.resolve(this.#opts.install(channels)).catch((err: unknown) => {
        this.#opts.logger.error("channel install failed", errorFields(err));
      });
    } catch (err) {
      this.#opts.logger.error("channel install failed", errorFields(err));
    }
  }

  #readFile(): void {
    const { readFile } = this.#opts;
    if (readFile === undefined) return;
    let text: string;
    try {
      text = readFile();
    } catch (err) {
      this.#fileProblem(
        "unreadable",
        "channel file cannot be read, keeping the last good channels",
        err,
      );
      return;
    }
    const sha = sha256(text);
    if (sha === this.#fileSha) return;
    this.#fileSha = sha;
    try {
      this.#fileChannels = this.#opts.parseFile(text).map(installedChannel);
      this.#fileRejected = undefined;
      this.#opts.logger.info("channel file applied", { channels: this.#fileChannels.length });
    } catch (err) {
      this.#fileRejected = { channelId: null, reason: "channel file: invalid, last good kept" };
      this.#opts.logger.warn("channel file is invalid, keeping the last good channels", {
        ...errorFields(err),
      });
    }
  }

  /** Logs an unreadable file once until it reads again. */
  #fileProblem(kind: string, message: string, err: unknown): void {
    this.#fileRejected = { channelId: null, reason: "channel file: unreadable, last good kept" };
    if (this.#fileSha === kind) return;
    this.#fileSha = kind;
    this.#opts.logger.warn(message, errorFields(err));
  }

  async #readRemote(): Promise<void> {
    const { fetchChannels } = this.#opts;
    if (fetchChannels === undefined) return;
    let read: ServiceRead<unknown>;
    try {
      read = await fetchChannels(this.#etag);
    } catch (err) {
      if (err instanceof ApiReadError && err.kind === "http:404") {
        this.#useOldApi();
        return;
      }
      const reason = err instanceof ApiReadError ? ANSWER_FAILURES.get(err.kind) : undefined;
      // Decision 6: a refused whole answer changes nothing but is reported, like a bad envelope.
      if (reason !== undefined) this.#rejected = [{ channelId: null, reason }];
      this.#opts.logger.warn("channels read failed, keeping the last good channels", {
        ...errorFields(err),
      });
      return;
    }
    this.#isOldApi = false;
    if (read.status === "not-modified") return;
    this.#applyAnswer(checkChannelsAnswer(read.value), read.etag);
  }

  /** An api without database channels: an empty remote layer, logged once. */
  #useOldApi(): void {
    if (!this.#isOldApi) {
      this.#isOldApi = true;
      this.#opts.logger.warn("the api has no database channels, using the file channels only");
    }
    this.#remote = new Map();
    this.#etag = undefined;
    this.#rejected = [];
  }

  #applyAnswer(answer: ChannelsAnswer, etag: string | undefined): void {
    if (answer.kind === "envelope") {
      // Decision 6: nothing changes; only the one rejection is reported.
      this.#rejected = [answer.rejected];
      this.#opts.logger.warn("channels answer refused, keeping the last good channels");
      return;
    }
    const previous = this.#remote;
    const next = new Map<string, RemoteEntry>();
    const rejected = [...answer.rejected];
    const now = this.#opts.now();
    for (const record of answer.records) {
      const resolved = resolveDatabaseChannel(record, this.#opts.secrets);
      if (resolved.ok) {
        const row = {
          id: record.id,
          definition: canonicalDefinition(record),
          revision: answer.revision,
          appliedAt: now,
        };
        next.set(record.id, { row, channel: installedChannel(resolved.config) });
      } else rejected.push(resolved.rejected);
    }
    // A rejected id keeps its last good version, with its earlier row unchanged.
    for (const { channelId } of rejected) {
      const kept = channelId === null ? undefined : previous.get(channelId);
      if (channelId !== null && kept !== undefined && !next.has(channelId))
        next.set(channelId, kept);
    }
    try {
      this.#opts.ledger.replaceRemoteChannels([...next.values()].map((e) => e.row));
    } catch (err) {
      this.#opts.logger.error("channels could not be stored, keeping the last good channels", {
        ...errorFields(err),
      });
      return;
    }
    this.#remote = next;
    this.#etag = etag;
    this.#appliedRevision = answer.revision;
    this.#rejected = rejected;
  }

  #effective(): ChannelConfig[] {
    const remote = [...this.#remote.values()].map((e) => e.channel);
    const set = effectiveSet(this.#fileChannels, remote);
    this.#shadowedIds = set.shadowedIds;
    return set.channels.map((c) => c.config);
  }
}
