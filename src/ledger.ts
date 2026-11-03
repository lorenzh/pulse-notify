import { Database } from "bun:sqlite";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import { isRecord, writeFileAtomicSync } from "@lorenzh/pulse-kit";
import type { Notification, RecipientProgress } from "./types.ts";

/**
 * `dropped`: a reminder that was not sent because its incident resolved first.
 * A newer reminder with any status except `dropped` supersedes an older one.
 */
export type LedgerStatus = "seeded" | "pending" | "delivered" | "failed" | "dropped";

const STATUSES: readonly LedgerStatus[] = ["seeded", "pending", "delivered", "failed", "dropped"];

/** Newest format this version reads and the only one it writes (a SQLite `user_version`). */
export const LEDGER_VERSION = 3;

const SCHEMA = `
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  reminders_from INTEGER,
  manual_from INTEGER,
  check_routing TEXT,
  component_routing TEXT
) STRICT;
CREATE TABLE entries (
  channel_id TEXT NOT NULL,
  key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('seeded','pending','delivered','failed','dropped')),
  at INTEGER NOT NULL,
  payload TEXT,
  recipients TEXT,
  PRIMARY KEY (channel_id, key)
) STRICT;
PRAGMA user_version = ${LEDGER_VERSION};
`;

const SQLITE_HEADER = "SQLite format 3\0";

/** A mutation on a ledger after `close()`. Nothing was written. */
export class LedgerClosedError extends Error {
  override readonly name = "LedgerClosedError";
  constructor() {
    super("ledger is closed");
  }
}

interface LedgerEntry {
  status: LedgerStatus;
  /** Epoch milliseconds of the last status change (the load time for a migrated v1 entry). */
  at: number;
  /** Kept for `pending` and `failed` keys, so they can be resent. */
  payload?: Notification | undefined;
  recipients?: RecipientProgress | undefined;
}

interface ChannelMarks {
  remindersFrom?: number | undefined;
  manualFrom?: number | undefined;
  checkRouting?: string | undefined;
  componentRouting?: string | undefined;
}

interface ChannelState {
  marks: ChannelMarks;
  /** Insertion order is the claim order. */
  entries: Map<string, LedgerEntry>;
}

type Mark = keyof ChannelMarks;

const MARK_COLUMNS: Record<Mark, string> = {
  remindersFrom: "reminders_from",
  manualFrom: "manual_from",
  checkRouting: "check_routing",
  componentRouting: "component_routing",
};

export interface PendingEntry {
  channelId: string;
  key: string;
  /** Absent for entries written by an older version. */
  notification?: Notification;
  /** Absent while no recipient progress was stored. */
  recipients?: RecipientProgress;
}

export interface FailedEntry {
  channelId: string;
  key: string;
  /** Epoch milliseconds when the delivery failed. */
  at: number;
  /** Absent for entries written by an older version: they cannot be resent. */
  notification?: Notification;
  recipients?: RecipientProgress;
}

export type ResendResult = "resent" | "no-payload" | "not-failed";

export interface LedgerMigration {
  from: 1 | 2;
  entries: number;
  backup: string;
}

export interface LedgerOptions {
  /** Clock for entry times. */
  now?: () => number;
  /** Test only. */
  hooks?: {
    /** Runs inside each write transaction; a throw rolls it back. */
    beforeCommit?: () => void;
    /** Runs after the migration backup and before the rename; a throw simulates a crash. */
    beforePublish?: () => void;
  };
}

// ---- JSON formats 1 and 2 (read only, for the migration) ----

interface JsonData {
  version: 1 | 2;
  channels: Map<string, ChannelState>;
  count: number;
}

/** Marks are optional: an entry that is not a finite number is dropped and counts as absent. */
function readMarks(raw: unknown): Record<string, number> {
  const marks: Record<string, number> = {};
  if (!isRecord(raw)) return marks;
  for (const [id, value] of Object.entries(raw)) {
    if (typeof value === "number" && Number.isFinite(value)) marks[id] = Math.trunc(value);
  }
  return marks;
}

function isStatus(value: unknown): value is LedgerStatus {
  return STATUSES.some((s) => s === value);
}

function migrateEntry(value: unknown, version: 1 | 2, loadedAt: number): LedgerEntry | undefined {
  if (version === 1 && isStatus(value)) return { status: value, at: loadedAt };
  if (isRecord(value) && isStatus(value.status) && typeof value.at === "number") {
    if (!Number.isFinite(value.at)) return undefined;
    return { status: value.status, at: Math.trunc(value.at) };
  }
  return undefined;
}

function migrateChannel(
  rawEntries: unknown,
  rawPayloads: unknown,
  version: 1 | 2,
  loadedAt: number,
): Map<string, LedgerEntry> | undefined {
  if (!isRecord(rawEntries)) return undefined;
  const payloads = isRecord(rawPayloads) ? rawPayloads : {};
  const entries = new Map<string, LedgerEntry>();
  for (const [key, value] of Object.entries(rawEntries)) {
    const entry = migrateEntry(value, version, loadedAt);
    if (!entry) return undefined;
    const payload = Object.hasOwn(payloads, key) ? payloads[key] : undefined;
    // Trust boundary: the payload was written by this service; only its shape is checked.
    if (isRecord(payload)) entry.payload = payload as unknown as Notification;
    entries.set(key, entry);
  }
  return entries;
}

/** Trust boundary: reads a JSON ledger (format 1 or 2) as far as the ledger relies on it. */
function parseJson(raw: unknown, loadedAt: number, path: string): JsonData {
  const bad = (): Error => unsupported(path);
  if (!isRecord(raw) || !isRecord(raw.channels)) throw bad();
  const version = raw.version;
  if (version !== 1 && version !== 2) throw bad();
  const payloads = isRecord(raw.payloads) ? raw.payloads : {};
  const reminders = version === 2 ? readMarks(raw.remindersFrom) : {};
  const manual = version === 2 ? readMarks(raw.manualFrom) : {};
  const channels = new Map<string, ChannelState>();
  let count = 0;
  for (const [id, rawEntries] of Object.entries(raw.channels)) {
    const entries = migrateChannel(rawEntries, payloads[id], version, loadedAt);
    if (!entries) throw bad();
    count += entries.size;
    const marks: ChannelMarks = {
      remindersFrom: Object.hasOwn(reminders, id) ? reminders[id] : undefined,
      manualFrom: Object.hasOwn(manual, id) ? manual[id] : undefined,
    };
    channels.set(id, { marks, entries });
  }
  return { version, channels, count };
}

// ---- Format 3 rows (trust boundary at open) ----

function unsupported(path: string, opts?: ErrorOptions): Error {
  return new Error(`ledger ${path} has an unsupported format`, opts);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function parseJsonText(text: unknown): unknown {
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // An unparsable column is reported as an unsupported format by the caller.
    return undefined;
  }
}

/** A row that breaks the format; the open reports it as an unsupported format. */
class BadRowError extends Error {
  override readonly name = "BadRowError";
}

/** Throws `BadRowError` unless `raw` is NULL or a JSON object. */
function readPayload(raw: unknown): Notification | undefined {
  if (raw === null) return undefined;
  const value = parseJsonText(raw);
  if (!isRecord(value)) throw new BadRowError("bad payload");
  return value as unknown as Notification;
}

/** Throws `BadRowError` unless `raw` is NULL or a `RecipientProgress` JSON. */
function readRecipients(raw: unknown): RecipientProgress | undefined {
  if (raw === null) return undefined;
  const value = parseJsonText(raw);
  if (!isRecord(value) || !isStringList(value.delivered) || !isStringList(value.refused)) {
    throw new BadRowError("bad recipients");
  }
  return { delivered: [...value.delivered], refused: [...value.refused] };
}

/** A routing fingerprint is NULL or a JSON object with exactly the two named string lists. */
function isFingerprint(raw: unknown, names: readonly [string, string]): raw is string | null {
  if (raw === null) return true;
  const value = parseJsonText(raw);
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === names.length &&
    names.every((n) => Object.hasOwn(value, n) && isStringList(value[n]))
  );
}

const CHECK_LISTS = ["checks", "excludeChecks"] as const;
const COMPONENT_LISTS = ["components", "excludeComponents"] as const;

function isOptionalInteger(raw: unknown): raw is number | null {
  return raw === null || (typeof raw === "number" && Number.isSafeInteger(raw));
}

function readChannelRow(row: Record<string, unknown>): [string, ChannelMarks] | undefined {
  const { id, reminders_from, manual_from, check_routing, component_routing } = row;
  if (typeof id !== "string") return undefined;
  if (!isOptionalInteger(reminders_from) || !isOptionalInteger(manual_from)) return undefined;
  if (!isFingerprint(check_routing, CHECK_LISTS)) return undefined;
  if (!isFingerprint(component_routing, COMPONENT_LISTS)) return undefined;
  return [
    id,
    {
      remindersFrom: reminders_from ?? undefined,
      manualFrom: manual_from ?? undefined,
      checkRouting: check_routing ?? undefined,
      componentRouting: component_routing ?? undefined,
    },
  ];
}

function readEntryRow(row: Record<string, unknown>): [string, string, LedgerEntry] | undefined {
  const { channel_id, key, status, at } = row;
  if (typeof channel_id !== "string" || typeof key !== "string") return undefined;
  if (!isStatus(status) || typeof at !== "number" || !Number.isSafeInteger(at)) return undefined;
  const payload = readPayload(row.payload);
  const recipients = readRecipients(row.recipients);
  return [channel_id, key, { status, at, payload, recipients }];
}

function loadRows(db: Database, path: string): Map<string, ChannelState> {
  const channels = new Map<string, ChannelState>();
  for (const row of db.query("SELECT * FROM channels ORDER BY rowid").all()) {
    const parsed = isRecord(row) ? readChannelRow(row) : undefined;
    if (!parsed) throw unsupported(path);
    channels.set(parsed[0], { marks: parsed[1], entries: new Map() });
  }
  for (const row of db.query("SELECT * FROM entries ORDER BY rowid").all()) {
    const parsed = isRecord(row) ? readEntryRow(row) : undefined;
    const channel = parsed ? channels.get(parsed[0]) : undefined;
    if (!parsed || !channel) throw unsupported(path);
    channel.entries.set(parsed[1], parsed[2]);
  }
  return channels;
}

// ---- Files ----

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** Sidecars of a database at `path`, plus the database itself when `withMain` is set. */
function removeDatabaseFiles(path: string, withMain: boolean): void {
  if (withMain) unlinkIfPresent(path);
  for (const suffix of ["-journal", "-wal", "-shm"]) unlinkIfPresent(`${path}${suffix}`);
}

function syncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** The first 16 bytes; `undefined` when there is no file. */
function readHeader(path: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  try {
    const buf = Buffer.alloc(16);
    const n = readSync(fd, buf, 0, 16, 0);
    return buf.subarray(0, n).toString("latin1");
  } finally {
    closeSync(fd);
  }
}

function writeRows(db: Database, channels: Map<string, ChannelState>): void {
  const insertChannel = db.query(
    "INSERT INTO channels (id, reminders_from, manual_from, check_routing, component_routing) VALUES (?, ?, ?, ?, ?)",
  );
  const insertEntry = db.query(
    "INSERT INTO entries (channel_id, key, status, at, payload, recipients) VALUES (?, ?, ?, ?, ?, ?)",
  );
  db.transaction(() => {
    for (const [id, { marks, entries }] of channels) {
      insertChannel.run(
        id,
        marks.remindersFrom ?? null,
        marks.manualFrom ?? null,
        marks.checkRouting ?? null,
        marks.componentRouting ?? null,
      );
      for (const [key, e] of entries) {
        insertEntry.run(id, key, e.status, e.at, json(e.payload), json(e.recipients));
      }
    }
  })();
}

function json(value: object | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

/**
 * Builds a format-3 database at `<path>.migrating` in rollback-journal mode and renames it over
 * `path`. Sidecars at `path` belong to an older database and would be replayed: they go first.
 */
function publish(
  path: string,
  channels: Map<string, ChannelState>,
  beforeRename?: () => void,
): void {
  const building = `${path}.migrating`;
  // SQLite creates a new file with the default mode and gives its journal, WAL and shm files
  // the mode of the database file. Creating it first keeps all of them private.
  closeSync(openSync(building, "wx", 0o600));
  const db = new Database(building, { create: true, readwrite: true });
  try {
    db.run(SCHEMA);
    writeRows(db, channels);
  } finally {
    db.close();
  }
  beforeRename?.();
  removeDatabaseFiles(path, false);
  renameSync(building, path);
  syncDir(dirname(path));
}

const REMINDER_KEY = /^(\d+):reminder:(\d+)$/;
const INCIDENT_KEY = /^(\d+):/;
const MANUAL_KEY = /^manual:(\d+):/;

/**
 * Durable delivery ledger: a SQLite database (format 3) in WAL mode with `synchronous = FULL`.
 *
 * Every mutation is one transaction that writes only the rows it changes; memory changes only
 * after the commit. A failed transaction rolls back, throws and leaves memory unchanged.
 * Reads come from a mirror loaded at open. A JSON ledger (format 1 or 2) is migrated at open.
 *
 * `manualFrom` marks a channel whose manual incidents were seeded on the first good manual read;
 * a channel without it gets the manual keys seeded quietly before manual detection runs.
 */
export class Ledger {
  readonly #path: string;
  readonly #now: () => number;
  readonly #beforeCommit: (() => void) | undefined;
  readonly #db: Database;
  readonly #channels: Map<string, ChannelState>;
  #isClosed = false;
  /** Set when this open migrated a JSON ledger. */
  readonly migration: LedgerMigration | undefined;

  constructor(path: string, opts: LedgerOptions = {}) {
    this.#path = path;
    this.#now = opts.now ?? Date.now;
    this.#beforeCommit = opts.hooks?.beforeCommit;
    removeDatabaseFiles(`${path}.migrating`, true);
    const header = readHeader(path);
    if (header === undefined) {
      mkdirSync(dirname(path), { recursive: true });
      publish(path, new Map());
    } else if (header !== SQLITE_HEADER) {
      this.migration = this.#migrateJson(opts.hooks?.beforePublish);
    }
    const opened = this.#open();
    this.#db = opened.db;
    this.#channels = opened.channels;
  }

  #migrateJson(beforePublish: (() => void) | undefined): LedgerMigration {
    const bytes = readFileSync(this.#path);
    const data = parseJson(JSON.parse(bytes.toString("utf8")), this.#now(), this.#path);
    const backup = `${this.#path}.v${data.version}.bak`;
    publish(this.#path, data.channels, () => {
      writeFileAtomicSync(backup, bytes);
      beforePublish?.();
    });
    return { from: data.version, entries: data.count, backup };
  }

  #open(): { db: Database; channels: Map<string, ChannelState> } {
    const channels = this.#validate();
    const db = new Database(this.#path, { create: false, readwrite: true });
    try {
      db.run("PRAGMA journal_mode = WAL");
      db.run("PRAGMA synchronous = FULL");
      return { db, channels };
    } catch (err) {
      db.close();
      throw err;
    }
  }

  /**
   * Reads and validates every row on a read-only connection. A read/write connection would
   * checkpoint a committed WAL on close and so change a refused file.
   */
  #validate(): Map<string, ChannelState> {
    const db = new Database(this.#path, { readonly: true });
    try {
      const row = db.query("PRAGMA user_version").get();
      if (!isRecord(row) || row.user_version !== LEDGER_VERSION) throw unsupported(this.#path);
      try {
        return loadRows(db, this.#path);
      } catch (err) {
        throw unsupported(this.#path, { cause: err });
      }
    } finally {
      db.close();
    }
  }

  /** Throws `LedgerClosedError` after `close()`. Runs first in every mutation, before any read. */
  #assertOpen(): void {
    if (this.#isClosed) throw new LedgerClosedError();
  }

  /** Runs `write` in one transaction, then `apply` to memory. */
  #transact(write: () => void, apply: () => void): void {
    this.#assertOpen();
    this.#db.transaction(() => {
      write();
      this.#beforeCommit?.();
    })();
    apply();
  }

  /** Checkpoints the WAL into the database file and truncates it. Rejects if that fails. */
  async flush(): Promise<void> {
    if (this.#isClosed) return;
    const row = this.#db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (isRecord(row) && row.busy !== 0) throw new Error("ledger checkpoint was blocked");
  }

  /** Closes the database. Every later mutation throws `LedgerClosedError`. */
  close(): void {
    if (this.#isClosed) return;
    this.#isClosed = true;
    this.#db.close();
  }

  hasChannel(channelId: string): boolean {
    return this.#channels.has(channelId);
  }

  #entry(channelId: string, key: string): LedgerEntry | undefined {
    return this.#channels.get(channelId)?.entries.get(key);
  }

  status(channelId: string, key: string): LedgerStatus | undefined {
    return this.#entry(channelId, key)?.status;
  }

  /** Keys of the channel with their status. */
  entries(channelId: string): [string, LedgerStatus][] {
    const entries = this.#channels.get(channelId)?.entries ?? new Map<string, LedgerEntry>();
    return [...entries].map(([key, e]) => [key, e.status]);
  }

  has(channelId: string, key: string): boolean {
    return this.status(channelId, key) !== undefined;
  }

  #mark<M extends Mark>(channelId: string, mark: M): ChannelMarks[M] {
    return this.#channels.get(channelId)?.marks[mark];
  }

  /** When reminders were switched on for the channel; `undefined` while they are off. */
  remindersFrom(channelId: string): number | undefined {
    return this.#mark(channelId, "remindersFrom");
  }

  /** When the manual feed was first seen and seeded for the channel; `undefined` before. */
  manualFrom(channelId: string): number | undefined {
    return this.#mark(channelId, "manualFrom");
  }

  /** The stored check routing fingerprint; `undefined` when none was stored yet. */
  checkRouting(channelId: string): string | undefined {
    return this.#mark(channelId, "checkRouting");
  }

  /** The stored component routing fingerprint; `undefined` when none was stored yet. */
  componentRouting(channelId: string): string | undefined {
    return this.#mark(channelId, "componentRouting");
  }

  /** Switches the reminder mark on (a time) or off (`undefined`). Creates the channel record. */
  setRemindersFrom(channelId: string, value: number | undefined): void {
    this.#assertOpen();
    if (this.remindersFrom(channelId) === value) return;
    this.#transact(
      () => {
        this.#upsertChannel(channelId);
        this.#db
          .query("UPDATE channels SET reminders_from = ? WHERE id = ?")
          .run(value ?? null, channelId);
      },
      () => {
        this.#channelState(channelId).marks.remindersFrom = value;
      },
    );
  }

  #upsertChannel(channelId: string): void {
    this.#db.query("INSERT OR IGNORE INTO channels (id) VALUES (?)").run(channelId);
  }

  #channelState(channelId: string): ChannelState {
    let channel = this.#channels.get(channelId);
    if (!channel) {
      channel = { marks: {}, entries: new Map() };
      this.#channels.set(channelId, channel);
    }
    return channel;
  }

  /**
   * Records the keys as handled without sending; creates the channel record.
   * `marks` are written in the same transaction; a failed write changes nothing.
   */
  seed(channelId: string, keys: string[], marks: ChannelMarks = {}): void {
    this.#assertOpen();
    const known = this.#channels.get(channelId)?.entries;
    const added = [...new Set(keys)].filter((key) => !known?.has(key));
    const at = this.#now();
    const given = (Object.keys(MARK_COLUMNS) as Mark[]).filter((m) => marks[m] !== undefined);
    this.#transact(
      () => {
        this.#upsertChannel(channelId);
        for (const mark of given) {
          this.#db
            .query(`UPDATE channels SET ${MARK_COLUMNS[mark]} = ? WHERE id = ?`)
            .run(marks[mark] ?? null, channelId);
        }
        const insert = this.#db.query(
          "INSERT INTO entries (channel_id, key, status, at) VALUES (?, ?, 'seeded', ?)",
        );
        for (const key of added) insert.run(channelId, key, at);
      },
      () => {
        const channel = this.#channelState(channelId);
        for (const mark of given) Object.assign(channel.marks, { [mark]: marks[mark] });
        for (const key of added) channel.entries.set(key, { status: "seeded", at });
      },
    );
  }

  /** The settled reminder keys of the same incident that are older than `key`. */
  #olderReminders(channelId: string, key: string): string[] {
    const latest = REMINDER_KEY.exec(key);
    const entries = this.#channels.get(channelId)?.entries;
    if (!latest || !entries) return [];
    const out: string[] = [];
    for (const [other, entry] of entries) {
      const match = REMINDER_KEY.exec(other);
      if (!match || match[1] !== latest[1] || entry.status === "pending") continue;
      if (Number(match[2]) < Number(latest[2])) out.push(other);
    }
    return out;
  }

  #deleteRows(channelId: string, keys: string[]): void {
    const del = this.#db.query("DELETE FROM entries WHERE channel_id = ? AND key = ?");
    for (const key of keys) del.run(channelId, key);
  }

  /**
   * Claims the key as pending before the first send and stores the notification for a resend.
   * False if the key is already recorded.
   */
  claim(channelId: string, key: string, notification: Notification): boolean {
    this.#assertOpen();
    if (this.has(channelId, key)) return false;
    const older = this.#olderReminders(channelId, key);
    const at = this.#now();
    this.#transact(
      () => {
        this.#upsertChannel(channelId);
        this.#deleteRows(channelId, older);
        this.#db
          .query(
            "INSERT INTO entries (channel_id, key, status, at, payload) VALUES (?, ?, 'pending', ?, ?)",
          )
          .run(channelId, key, at, JSON.stringify(notification));
      },
      () => {
        const channel = this.#channelState(channelId);
        for (const other of older) channel.entries.delete(other);
        channel.entries.set(key, { status: "pending", at, payload: notification });
      },
    );
    return true;
  }

  /** Ends a pending claim. A `failed` key keeps its notification and recipients for a resend. */
  settle(channelId: string, key: string, status: "delivered" | "failed" | "dropped"): void {
    this.#assertOpen();
    const entry = this.#entry(channelId, key);
    if (entry?.status !== "pending") {
      throw new Error(`cannot settle ${channelId}/${key}: not pending`);
    }
    const at = this.#now();
    const isKept = status === "failed";
    this.#transact(
      () => {
        const sql = isKept
          ? "UPDATE entries SET status = ?, at = ? WHERE channel_id = ? AND key = ?"
          : "UPDATE entries SET status = ?, at = ?, payload = NULL, recipients = NULL WHERE channel_id = ? AND key = ?";
        this.#db.query(sql).run(status, at, channelId, key);
      },
      () => {
        entry.status = status;
        entry.at = at;
        if (!isKept) {
          entry.payload = undefined;
          entry.recipients = undefined;
        }
      },
    );
  }

  /** Stores the recipient progress of a pending or failed key. */
  setRecipients(channelId: string, key: string, progress: RecipientProgress): void {
    this.#assertOpen();
    const entry = this.#entry(channelId, key);
    if (entry?.status !== "pending" && entry?.status !== "failed") {
      throw new Error(`cannot store recipients of ${channelId}/${key}: not pending`);
    }
    const copy = { delivered: [...progress.delivered], refused: [...progress.refused] };
    this.#transact(
      () => {
        this.#db
          .query("UPDATE entries SET recipients = ? WHERE channel_id = ? AND key = ?")
          .run(JSON.stringify(copy), channelId, key);
      },
      () => {
        entry.recipients = copy;
      },
    );
  }

  /** Pending keys in the order they were claimed. */
  pending(): PendingEntry[] {
    const out: PendingEntry[] = [];
    for (const [channelId, { entries }] of this.#channels) {
      for (const [key, e] of entries) {
        if (e.status !== "pending") continue;
        const item: PendingEntry = { channelId, key };
        if (e.payload) item.notification = e.payload;
        if (e.recipients) item.recipients = e.recipients;
        out.push(item);
      }
    }
    return out;
  }

  /** Failed keys, oldest failure first. */
  failed(): FailedEntry[] {
    const out: FailedEntry[] = [];
    for (const [channelId, { entries }] of this.#channels) {
      for (const [key, e] of entries) {
        if (e.status !== "failed") continue;
        const item: FailedEntry = { channelId, key, at: e.at };
        if (e.payload) item.notification = e.payload;
        if (e.recipients) item.recipients = e.recipients;
        out.push(item);
      }
    }
    return out.sort((a, b) => a.at - b.at);
  }

  /**
   * Sets a failed key back to `pending` with its stored notification. Delivered recipients
   * stay; refused ones are cleared, so they are tried once more.
   */
  resend(channelId: string, key: string): ResendResult {
    this.#assertOpen();
    const entry = this.#entry(channelId, key);
    if (entry?.status !== "failed") return "not-failed";
    if (!entry.payload) return "no-payload";
    const at = this.#now();
    const recipients = entry.recipients
      ? { delivered: [...entry.recipients.delivered], refused: [] }
      : undefined;
    this.#transact(
      () => {
        this.#db
          .query(
            "UPDATE entries SET status = 'pending', at = ?, recipients = ? WHERE channel_id = ? AND key = ?",
          )
          .run(at, json(recipients), channelId, key);
      },
      () => {
        entry.status = "pending";
        entry.at = at;
        entry.recipients = recipients;
      },
    );
    return "resent";
  }

  /**
   * Removes settled entries (not `pending`) older than `maxAgeMs`, with their notifications.
   * A key of an incident in `visible` (or a manual one in `visibleManual`) stays, or it would look unhandled and be sent again.
   * When `visible` is `undefined` (no successful poll yet), every incident key stays.
   * Returns the number of removed entries.
   */
  prune(
    maxAgeMs: number,
    visible: ReadonlySet<number> | undefined,
    visibleManual?: ReadonlySet<number>,
  ): number {
    this.#assertOpen();
    const cutoff = this.#now() - maxAgeMs;
    const removed: [string, string[]][] = [];
    let count = 0;
    for (const [channelId, { entries }] of this.#channels) {
      const keys = [...entries]
        .filter(([key, e]) => isPrunable(key, e, cutoff, visible, visibleManual))
        .map(([key]) => key);
      if (keys.length === 0) continue;
      removed.push([channelId, keys]);
      count += keys.length;
    }
    if (count === 0) return 0;
    this.#transact(
      () => {
        for (const [channelId, keys] of removed) this.#deleteRows(channelId, keys);
      },
      () => {
        for (const [channelId, keys] of removed) {
          const entries = this.#channels.get(channelId)?.entries;
          for (const key of keys) entries?.delete(key);
        }
      },
    );
    return count;
  }
}

function isPrunable(
  key: string,
  entry: LedgerEntry,
  cutoff: number,
  visible: ReadonlySet<number> | undefined,
  visibleManual: ReadonlySet<number> | undefined,
): boolean {
  if (entry.status === "pending" || entry.at >= cutoff) return false;
  const match = INCIDENT_KEY.exec(key);
  if (match && (visible === undefined || visible.has(Number(match[1])))) return false;
  const manual = MANUAL_KEY.exec(key);
  return !(manual && (visibleManual === undefined || visibleManual.has(Number(manual[1]))));
}
