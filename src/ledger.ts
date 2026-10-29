import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { Notification, Schedule } from "./types.ts";

/**
 * `dropped`: a reminder that was not sent because its incident resolved first.
 * A newer reminder with any status except `dropped` supersedes an older one.
 */
export type LedgerStatus = "seeded" | "pending" | "delivered" | "failed" | "dropped";

const STATUSES: readonly LedgerStatus[] = ["seeded", "pending", "delivered", "failed", "dropped"];

/** Newest format this version reads and the only one it writes. */
export const LEDGER_VERSION = 2;

/** Quiet time before batched changes (settle, prune) are written. */
export const WRITE_BATCH_MS = 100;

interface LedgerEntry {
  status: LedgerStatus;
  /** Epoch milliseconds of the last status change (the load time for a migrated v1 entry). */
  at: number;
}

interface LedgerData {
  version: typeof LEDGER_VERSION;
  channels: Record<string, Record<string, LedgerEntry>>;
  /** Notifications of `pending` and `failed` keys, so they can be resent. */
  payloads?: Record<string, Record<string, Notification>>;
  /** Per channel: when reminders were switched on (epoch ms). Absent while they are off. */
  remindersFrom?: Record<string, number>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStatus(value: unknown): value is LedgerStatus {
  return STATUSES.some((s) => s === value);
}

function migrateEntries(
  rawEntries: Record<string, unknown>,
  version: unknown,
  loadedAt: number,
): Record<string, LedgerEntry> | undefined {
  const entries: Record<string, LedgerEntry> = {};
  for (const [key, value] of Object.entries(rawEntries)) {
    if (version === 1 && isStatus(value)) {
      entries[key] = { status: value, at: loadedAt };
    } else if (isObject(value) && isStatus(value.status) && typeof value.at === "number") {
      entries[key] = { status: value.status, at: value.at };
    } else {
      return undefined;
    }
  }
  return entries;
}

/** Trust boundary: reads the file content as far as the ledger relies on it. */
function migrate(raw: unknown, loadedAt: number, path: string): LedgerData {
  const bad = (): Error => new Error(`ledger ${path} has an unsupported format`);
  if (!isObject(raw) || !isObject(raw.channels)) throw bad();
  if (raw.version !== 1 && raw.version !== LEDGER_VERSION) throw bad();
  const channels: LedgerData["channels"] = {};
  for (const [id, rawEntries] of Object.entries(raw.channels)) {
    const entries = isObject(rawEntries)
      ? migrateEntries(rawEntries, raw.version, loadedAt)
      : undefined;
    if (!entries) throw bad();
    channels[id] = entries;
  }
  const data: LedgerData = { version: LEDGER_VERSION, channels };
  if (isObject(raw.payloads)) data.payloads = raw.payloads as LedgerData["payloads"] & object;
  if (raw.version === LEDGER_VERSION && isObject(raw.remindersFrom)) {
    data.remindersFrom = raw.remindersFrom as Record<string, number>;
  }
  return data;
}

const REMINDER_KEY = /^(\d+):reminder:(\d+)$/;
const INCIDENT_KEY = /^(\d+):/;

interface Removed {
  key: string;
  entry: LedgerEntry;
  notification?: Notification | undefined;
}

export interface PendingEntry {
  channelId: string;
  key: string;
  /** Absent for entries written by an older version. */
  notification?: Notification;
}

export interface FailedEntry {
  channelId: string;
  key: string;
  /** Epoch milliseconds when the delivery failed. */
  at: number;
  /** Absent for entries written by an older version: they cannot be resent. */
  notification?: Notification;
}

export type ResendResult = "resent" | "no-payload" | "not-failed";

export interface LedgerOptions {
  /** Clock for entry times. */
  now?: () => number;
  /** Timer for batched writes. */
  schedule?: Schedule;
  /** Receives the error of a batched write that failed; the changes stay queued for the next write. */
  onError?: (err: Error) => void;
  /** Test only: lets a test pause a batched write between its temp file and the rename. */
  hooks?: { beforeRename?: () => Promise<void> };
}

/**
 * Durable delivery ledger: one JSON file, rewritten atomically (temp file + rename).
 *
 * `seed`, `claim` and `resend` write at once and fsync: a claim must be on disk before the first
 * send. `settle`, `prune` and `setRemindersFrom` change memory and are written in one batch after
 * `WRITE_BATCH_MS`, or by `flush()`. A lost batch only causes a resend after a crash.
 * A sync write that fails throws and undoes its own change.
 */
export class Ledger {
  readonly #path: string;
  readonly #now: () => number;
  readonly #schedule: Schedule;
  readonly #onError: (err: Error) => void;
  readonly #beforeRename: (() => Promise<void>) | undefined;
  #data: LedgerData;
  #isDirty = false;
  #isClosed = false;
  #cancelTimer: (() => void) | undefined;
  /** Counts sync writes, so a batch that raced one knows its snapshot is outdated. */
  #syncWrites = 0;
  /** Batched writes run one after another. */
  #chain: Promise<void> = Promise.resolve();

  constructor(path: string, opts: LedgerOptions = {}) {
    this.#path = path;
    this.#now = opts.now ?? Date.now;
    this.#schedule = opts.schedule ?? unrefSchedule;
    this.#onError = opts.onError ?? (() => {});
    this.#beforeRename = opts.hooks?.beforeRename;
    this.#data = this.#load();
  }

  #load(): LedgerData {
    let text: string;
    try {
      text = readFileSync(this.#path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: LEDGER_VERSION, channels: {} };
      }
      throw err;
    }
    return migrate(JSON.parse(text), this.#now(), this.#path);
  }

  /** Writes the whole current state to disk before it returns. */
  #writeSync(): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.tmp`;
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, JSON.stringify(this.#data));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.#path);
    this.#syncWrites++;
    this.#isDirty = false;
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
  }

  /** The change is already in memory: write it now, or call `undo` and rethrow. */
  #commit(undo: () => void): void {
    try {
      this.#writeSync();
    } catch (err) {
      undo();
      throw err;
    }
  }

  #markDirty(): void {
    this.#isDirty = true;
    if (this.#cancelTimer || this.#isClosed) return;
    this.#cancelTimer = this.#schedule(() => {
      this.#cancelTimer = undefined;
      this.#writeBatch().catch((err: unknown) => {
        this.#onError(err instanceof Error ? err : new Error(String(err)));
      });
    }, WRITE_BATCH_MS);
  }

  #writeBatch(): Promise<void> {
    this.#chain = this.#chain.then(
      () => this.#writeSnapshot(),
      () => this.#writeSnapshot(),
    );
    return this.#chain;
  }

  async #writeSnapshot(): Promise<void> {
    if (!this.#isDirty || this.#isClosed) return;
    const syncWrites = this.#syncWrites;
    const text = JSON.stringify(this.#data);
    const tmp = `${this.#path}.batch.tmp`;
    try {
      const file = await open(tmp, "w");
      try {
        await file.writeFile(text);
        await file.sync();
      } finally {
        await file.close();
      }
      if (syncWrites !== this.#syncWrites || this.#isClosed) {
        // A sync write saved a newer state meanwhile; renaming this snapshot would undo it.
        await discard(tmp);
        return;
      }
      await this.#beforeRename?.();
      await rename(tmp, this.#path);
      // The rename above is the only point where a sync write can slip in unseen: re-check.
      if (syncWrites !== this.#syncWrites) {
        if (!this.#isClosed) this.#writeSync();
      } else {
        this.#isDirty = this.#hasChangedSince(text);
      }
    } catch (err) {
      this.#isDirty = true;
      await discard(tmp).catch(() => {
        // Best effort: the original error is the one to report.
      });
      throw err;
    }
  }

  /** True when memory changed after the snapshot `text` was taken. */
  #hasChangedSince(text: string): boolean {
    return JSON.stringify(this.#data) !== text;
  }

  /** Writes the batched changes now. Rejects if that fails. Call it before the process exits. */
  async flush(): Promise<void> {
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
    await this.#writeBatch();
  }

  /** Stops batched writes for good, for a process that lost its lock. */
  close(): void {
    this.#isClosed = true;
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
  }

  hasChannel(channelId: string): boolean {
    return Object.hasOwn(this.#data.channels, channelId);
  }

  #entry(channelId: string, key: string): LedgerEntry | undefined {
    const entries = this.#data.channels[channelId];
    return entries && Object.hasOwn(entries, key) ? entries[key] : undefined;
  }

  status(channelId: string, key: string): LedgerStatus | undefined {
    return this.#entry(channelId, key)?.status;
  }

  /** Keys of the channel with their status. */
  entries(channelId: string): [string, LedgerStatus][] {
    return Object.entries(this.#data.channels[channelId] ?? {}).map(([key, e]) => [key, e.status]);
  }

  has(channelId: string, key: string): boolean {
    return this.status(channelId, key) !== undefined;
  }

  /** When reminders were switched on for the channel; `undefined` while they are off. */
  remindersFrom(channelId: string): number | undefined {
    const from = this.#data.remindersFrom;
    return from && Object.hasOwn(from, channelId) ? from[channelId] : undefined;
  }

  /** Switches the reminder mark on (a time) or off (`undefined`). Written in a batch. */
  setRemindersFrom(channelId: string, value: number | undefined): void {
    if (this.remindersFrom(channelId) === value) return;
    if (value === undefined) {
      if (this.#data.remindersFrom) delete this.#data.remindersFrom[channelId];
    } else {
      this.#data.remindersFrom ??= {};
      this.#data.remindersFrom[channelId] = value;
    }
    this.#markDirty();
  }

  /**
   * Records the keys as handled without sending; creates the channel record.
   * `remindersFrom` sets the reminder mark in the same write.
   */
  seed(channelId: string, keys: string[], remindersFrom?: number): void {
    const hadChannel = this.hasChannel(channelId);
    const entries = this.#data.channels[channelId] ?? {};
    const added: string[] = [];
    const at = this.#now();
    for (const key of keys) {
      if (Object.hasOwn(entries, key)) continue;
      entries[key] = { status: "seeded", at };
      added.push(key);
    }
    this.#data.channels[channelId] = entries;
    const previousMark = this.remindersFrom(channelId);
    if (remindersFrom !== undefined) {
      this.#data.remindersFrom ??= {};
      this.#data.remindersFrom[channelId] = remindersFrom;
    }
    this.#commit(() => {
      for (const key of added) delete entries[key];
      if (!hadChannel) delete this.#data.channels[channelId];
      if (remindersFrom !== undefined && this.#data.remindersFrom) {
        if (previousMark === undefined) delete this.#data.remindersFrom[channelId];
        else this.#data.remindersFrom[channelId] = previousMark;
      }
    });
  }

  /** Removes the settled reminder keys of the same incident that are older than `key`. */
  #pruneReminders(entries: Record<string, LedgerEntry>, channelId: string, key: string): Removed[] {
    const removed: Removed[] = [];
    const latest = REMINDER_KEY.exec(key);
    if (!latest) return removed;
    for (const [other, entry] of Object.entries(entries)) {
      const match = REMINDER_KEY.exec(other);
      if (!match || match[1] !== latest[1] || entry.status === "pending") continue;
      if (Number(match[2]) >= Number(latest[2])) continue;
      removed.push(this.#remove(entries, channelId, other));
    }
    return removed;
  }

  #remove(entries: Record<string, LedgerEntry>, channelId: string, key: string): Removed {
    const entry = entries[key] as LedgerEntry;
    const payloads = this.#data.payloads?.[channelId];
    const hasPayload = payloads !== undefined && Object.hasOwn(payloads, key);
    const removed: Removed = { key, entry, notification: hasPayload ? payloads[key] : undefined };
    delete entries[key];
    if (hasPayload) delete payloads[key];
    return removed;
  }

  #restore(channelId: string, removed: Removed[]): void {
    const entries = this.#data.channels[channelId] ?? {};
    this.#data.channels[channelId] = entries;
    for (const { key, entry, notification } of removed) {
      entries[key] = entry;
      if (notification) this.#setPayload(channelId, key, notification);
    }
  }

  #setPayload(channelId: string, key: string, notification: Notification): void {
    this.#data.payloads ??= {};
    const payloads = this.#data.payloads[channelId] ?? {};
    payloads[key] = notification;
    this.#data.payloads[channelId] = payloads;
  }

  /**
   * Claims the key as pending before the first send and stores the notification for a resend.
   * False if the key is already recorded.
   */
  claim(channelId: string, key: string, notification: Notification): boolean {
    if (this.has(channelId, key)) return false;
    const hadChannel = this.hasChannel(channelId);
    const entries = this.#data.channels[channelId] ?? {};
    this.#data.channels[channelId] = entries;
    const removed = this.#pruneReminders(entries, channelId, key);
    entries[key] = { status: "pending", at: this.#now() };
    this.#setPayload(channelId, key, notification);
    this.#commit(() => {
      delete entries[key];
      const payloads = this.#data.payloads?.[channelId];
      if (payloads) delete payloads[key];
      this.#restore(channelId, removed);
      if (!hadChannel && Object.keys(entries).length === 0) delete this.#data.channels[channelId];
    });
    return true;
  }

  /**
   * Ends a pending claim. A `failed` key keeps its notification so it can be resent.
   * Written in a batch.
   */
  settle(channelId: string, key: string, status: "delivered" | "failed" | "dropped"): void {
    const entry = this.#entry(channelId, key);
    if (entry?.status !== "pending") {
      throw new Error(`cannot settle ${channelId}/${key}: not pending`);
    }
    entry.status = status;
    entry.at = this.#now();
    const payloads = this.#data.payloads?.[channelId];
    if (payloads && status !== "failed") delete payloads[key];
    this.#markDirty();
  }

  /** Pending keys in the order they were claimed. */
  pending(): PendingEntry[] {
    const out: PendingEntry[] = [];
    for (const [channelId, entries] of Object.entries(this.#data.channels)) {
      for (const [key, { status }] of Object.entries(entries)) {
        if (status !== "pending") continue;
        const notification = this.#payload(channelId, key);
        out.push(notification ? { channelId, key, notification } : { channelId, key });
      }
    }
    return out;
  }

  #payload(channelId: string, key: string): Notification | undefined {
    const payloads = this.#data.payloads?.[channelId];
    return payloads && Object.hasOwn(payloads, key) ? payloads[key] : undefined;
  }

  /** Failed keys, oldest failure first. */
  failed(): FailedEntry[] {
    const out: FailedEntry[] = [];
    for (const [channelId, entries] of Object.entries(this.#data.channels)) {
      for (const [key, { status, at }] of Object.entries(entries)) {
        if (status !== "failed") continue;
        const notification = this.#payload(channelId, key);
        out.push(notification ? { channelId, key, at, notification } : { channelId, key, at });
      }
    }
    return out.sort((a, b) => a.at - b.at);
  }

  /** Sets a failed key back to `pending` with its stored notification. Written at once. */
  resend(channelId: string, key: string): ResendResult {
    const entry = this.#entry(channelId, key);
    if (entry?.status !== "failed") return "not-failed";
    if (!this.#payload(channelId, key)) return "no-payload";
    const previous = { ...entry };
    entry.status = "pending";
    entry.at = this.#now();
    this.#commit(() => Object.assign(entry, previous));
    return "resent";
  }

  /**
   * Removes settled entries (not `pending`) older than `maxAgeMs`, with their notifications.
   * A key of an incident in `visible` stays, or it would look unhandled and be sent again.
   * When `visible` is `undefined` (no successful poll yet), every incident key stays.
   * Returns the number of removed entries. Written in a batch.
   */
  prune(maxAgeMs: number, visible: ReadonlySet<number> | undefined): number {
    const cutoff = this.#now() - maxAgeMs;
    let count = 0;
    for (const [channelId, entries] of Object.entries(this.#data.channels)) {
      for (const [key, entry] of Object.entries(entries)) {
        if (entry.status === "pending" || entry.at >= cutoff) continue;
        const match = INCIDENT_KEY.exec(key);
        if (match && (visible === undefined || visible.has(Number(match[1])))) continue;
        this.#remove(entries, channelId, key);
        count++;
      }
    }
    if (count > 0) this.#markDirty();
    return count;
  }
}

const unrefSchedule: Schedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

/** Removes a temp file; a missing file is fine. */
async function discard(tmp: string): Promise<void> {
  try {
    await unlink(tmp);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
