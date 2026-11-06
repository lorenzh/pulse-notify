import { Database } from "bun:sqlite";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isAdminRevision, validateNotifyChannelDefinition } from "@lorenzh/pulse-contract";
import { isRecord, writeFileAtomicSync } from "@lorenzh/pulse-kit";
import type { Notification, RecipientProgress } from "./types.ts";

/**
 * `dropped`: a reminder that was not sent because its incident resolved first.
 * A newer reminder with any status except `dropped` supersedes an older one.
 */
export type LedgerStatus = "seeded" | "pending" | "delivered" | "failed" | "dropped";

const STATUSES: readonly LedgerStatus[] = ["seeded", "pending", "delivered", "failed", "dropped"];

/** Newest format this version reads and the only one it writes (a SQLite `user_version`). */
export const LEDGER_VERSION = 5;

/** Earlier SQLite formats; such a file is migrated at open. */
const PREVIOUS_VERSIONS: ReadonlySet<number> = new Set([3, 4]);

/** The notify side of a resend command (Decision 14). */
export type ResendCommandState =
  | "admitted"
  | "delivered"
  | "failed"
  | "dropped"
  | "not-failed"
  | "no-payload"
  | "channel-unavailable";

const RESEND_STATES: readonly ResendCommandState[] = [
  "admitted",
  "delivered",
  "failed",
  "dropped",
  "not-failed",
  "no-payload",
  "channel-unavailable",
];

const RESEND_STATE_SQL = RESEND_STATES.map((s) => `'${s}'`).join(",");

/** A finished command row that the api has acknowledged is pruned after this age. */
export const RESEND_COMMAND_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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
CREATE TABLE alert_state (
  kind TEXT NOT NULL CHECK (kind IN ('budget-check','budget-component','expiry')),
  subject_id TEXT NOT NULL,
  last_event_at INTEGER,
  stage INTEGER CHECK (stage IN (14, 3)),
  episode_at INTEGER,
  observed_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, subject_id)
) STRICT;
CREATE TABLE remote_channels (
  id TEXT PRIMARY KEY,
  definition TEXT NOT NULL,
  revision TEXT NOT NULL,
  applied_at INTEGER NOT NULL
) STRICT;
CREATE TABLE resend_commands (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (${RESEND_STATE_SQL})),
  posted_state TEXT CHECK (posted_state IS NULL OR posted_state IN (${RESEND_STATE_SQL})),
  updated_at INTEGER NOT NULL
) STRICT;
PRAGMA user_version = ${LEDGER_VERSION};
`;

const SQLITE_HEADER = "SQLite format 3\0";

/**
 * Runs `read` on a read-only connection to a private copy of `path` with its `-wal` and `-shm`
 * files. SQLite rewrites the WAL index in `-shm` even on a read-only connection, so reading the
 * original would change a file that is then refused. The copy lives in a 0700 temp directory.
 */
function readSnapshot<T>(path: string, read: (db: Database) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "notify-ledger-read-"));
  try {
    const copy = join(dir, "state");
    copyFileSync(path, copy);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${path}${suffix}`)) copyFileSync(`${path}${suffix}`, `${copy}${suffix}`);
    }
    const db = new Database(copy, { readonly: true });
    try {
      return read(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface LoadedRows {
  channels: Map<string, ChannelState>;
  alerts: AlertMirror;
  remoteChannels: Map<string, RemoteChannelRow>;
  resendCommands: Map<string, ResendCommandRow>;
}

/**
 * The last applied version of one database channel (Decision 17). `definition` is its canonical
 * JSON with references only, never a resolved secret.
 */
export interface RemoteChannelRow {
  id: string;
  definition: string;
  /** The notify revision of the channels answer that this version came from. */
  revision: string;
  appliedAt: number;
}

/** The notify side of one resend command. */
export interface ResendCommandRow {
  id: string;
  channelId: string;
  key: string;
  state: ResendCommandState;
  /** The state the api acknowledged; `undefined` before a post was acknowledged. */
  postedState: ResendCommandState | undefined;
  updatedAt: number;
}

/** A WAL checkpoint that could not move every committed frame into the database file. */
export class LedgerCheckpointError extends Error {
  override readonly name = "LedgerCheckpointError";
  constructor() {
    super("ledger checkpoint was blocked");
  }
}

/** A row that a caller asked to store does not pass the checks of a load. Nothing was written. */
export class LedgerRowError extends Error {
  override readonly name = "LedgerRowError";
}

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

export type AlertKind = "budget-check" | "budget-component" | "expiry";

const ALERT_KINDS: readonly AlertKind[] = ["budget-check", "budget-component", "expiry"];

export type ExpiryStage = 14 | 3;

/** The stored alert state of one subject. Budget rows use `lastEventAt`, expiry rows the rest. */
export interface AlertState {
  lastEventAt?: number | undefined;
  /** `undefined` is the stage `none`. */
  stage?: ExpiryStage | undefined;
  episodeAt?: number | undefined;
  observedAt?: number | undefined;
  /** Epoch milliseconds of the commit of the last change. */
  updatedAt: number;
}

/** A new value for the row of `kind`/`subjectId`; `updatedAt` is set at the commit. */
export interface AlertUpsert {
  kind: AlertKind;
  subjectId: string;
  state: Omit<AlertState, "updatedAt">;
}

/** A warning to store as `pending` on a channel that has no entry with its key. */
export interface AlertDelivery {
  channelId: string;
  key: string;
  notification: Notification;
}

/** The subjects of the last good read of each feed in this run; `undefined` before one. */
export interface AlertFeedPresence {
  checks?: ReadonlySet<string> | undefined;
  components?: ReadonlySet<string> | undefined;
}

const WARNING_EVENTS: ReadonlySet<string> = new Set(["budget-low", "tls-expiry", "domain-expiry"]);

export type ResendResult = "resent" | "no-payload" | "not-failed";

export interface LedgerMigration {
  from: 1 | 2 | 3 | 4;
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
    /** Runs after the sidecars of the path are removed and before the rename; a throw simulates a crash. */
    afterSidecars?: () => void;
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

function isStage(raw: unknown): raw is ExpiryStage | null {
  return raw === null || raw === 14 || raw === 3;
}

function isAlertKind(raw: unknown): raw is AlertKind {
  return ALERT_KINDS.some((k) => k === raw);
}

function readAlertRow(row: Record<string, unknown>): [AlertKind, string, AlertState] | undefined {
  const { kind, subject_id, last_event_at, stage, episode_at, observed_at, updated_at } = row;
  if (!isAlertKind(kind) || typeof subject_id !== "string" || !isStage(stage)) return undefined;
  if (!isOptionalInteger(last_event_at) || !isOptionalInteger(episode_at)) return undefined;
  if (!isOptionalInteger(observed_at) || !isOptionalInteger(updated_at)) return undefined;
  if (updated_at === null) return undefined;
  return [
    kind,
    subject_id,
    {
      lastEventAt: last_event_at ?? undefined,
      stage: stage ?? undefined,
      episodeAt: episode_at ?? undefined,
      observedAt: observed_at ?? undefined,
      updatedAt: updated_at,
    },
  ];
}

type AlertMirror = Map<AlertKind, Map<string, AlertState>>;

function emptyAlerts(): AlertMirror {
  return new Map(ALERT_KINDS.map((k) => [k, new Map<string, AlertState>()]));
}

function loadAlerts(db: Database, path: string): AlertMirror {
  const alerts = emptyAlerts();
  for (const row of db.query("SELECT * FROM alert_state ORDER BY rowid").all()) {
    const parsed = isRecord(row) ? readAlertRow(row) : undefined;
    if (!parsed) throw unsupported(path);
    alerts.get(parsed[0])?.set(parsed[1], parsed[2]);
  }
  return alerts;
}

function isResendState(raw: unknown): raw is ResendCommandState {
  return RESEND_STATES.includes(raw as ResendCommandState);
}

function isTime(raw: unknown): raw is number {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0;
}

/** The canonical JSON must be a valid database channel definition: references only. */
function isDefinition(raw: unknown, id: string): raw is string {
  if (typeof raw !== "string") return false;
  const parsed = parseJsonText(raw);
  if (!isRecord(parsed) || parsed.id !== id) return false;
  return validateNotifyChannelDefinition(parsed).ok;
}

function readRemoteRow(row: Record<string, unknown>): RemoteChannelRow | undefined {
  const { id, definition, revision, applied_at } = row;
  if (typeof id !== "string" || !isDefinition(definition, id)) return undefined;
  if (!isAdminRevision(revision) || !isTime(applied_at)) return undefined;
  return { id, definition, revision, appliedAt: applied_at };
}

function readResendRow(row: Record<string, unknown>): ResendCommandRow | undefined {
  const { id, channel_id, key, state, posted_state, updated_at } = row;
  if (typeof id !== "string" || typeof channel_id !== "string" || typeof key !== "string") {
    return undefined;
  }
  if (!isResendState(state) || !isTime(updated_at)) return undefined;
  if (posted_state !== null && !isResendState(posted_state)) return undefined;
  return {
    id,
    channelId: channel_id,
    key,
    state,
    postedState: posted_state ?? undefined,
    updatedAt: updated_at,
  };
}

function loadTable<T extends { id: string }>(
  db: Database,
  table: "remote_channels" | "resend_commands",
  read: (row: Record<string, unknown>) => T | undefined,
  path: string,
): Map<string, T> {
  const out = new Map<string, T>();
  for (const row of db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()) {
    const parsed = isRecord(row) ? read(row) : undefined;
    if (!parsed) throw unsupported(path);
    out.set(parsed.id, parsed);
  }
  return out;
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

function emptyRows(): LoadedRows {
  return {
    channels: new Map(),
    alerts: emptyAlerts(),
    remoteChannels: new Map(),
    resendCommands: new Map(),
  };
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

function walSize(path: string): number {
  try {
    return statSync(`${path}-wal`).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
}

/**
 * Moves every committed WAL frame into the database file. Throws `LedgerCheckpointError` and
 * deletes nothing unless the main file alone then holds every committed row.
 */
function checkpoint(path: string): void {
  const db = new Database(path, { create: false, readwrite: true });
  let isComplete = false;
  try {
    db.run("PRAGMA synchronous = FULL");
    const row = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
    isComplete = isRecord(row) && row.busy === 0 && row.log === row.checkpointed;
  } finally {
    db.close();
  }
  if (!isComplete || walSize(path) > 0) throw new LedgerCheckpointError();
}

function writeAlerts(db: Database, alerts: AlertMirror): void {
  const insert = db.query(
    "INSERT INTO alert_state (kind, subject_id, last_event_at, stage, episode_at, observed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  db.transaction(() => {
    for (const [kind, rows] of alerts) {
      for (const [subjectId, a] of rows) {
        insert.run(
          kind,
          subjectId,
          a.lastEventAt ?? null,
          a.stage ?? null,
          a.episodeAt ?? null,
          a.observedAt ?? null,
          a.updatedAt,
        );
      }
    }
  })();
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
 * Builds a format-5 database at `<path>.migrating` in rollback-journal mode and renames it over
 * `path`. Sidecars at `path` belong to an older database and would be replayed: they go first.
 * The two format-5 tables start empty.
 */
function publish(
  path: string,
  channels: Map<string, ChannelState>,
  alerts: AlertMirror,
  beforeRename?: () => void,
  afterSidecars?: () => void,
): void {
  const building = `${path}.migrating`;
  // SQLite creates a new file with the default mode and gives its journal, WAL and shm files
  // the mode of the database file. Creating it first keeps all of them private.
  closeSync(openSync(building, "wx", 0o600));
  const db = new Database(building, { create: true, readwrite: true });
  try {
    db.run(SCHEMA);
    writeRows(db, channels);
    writeAlerts(db, alerts);
  } finally {
    db.close();
  }
  beforeRename?.();
  removeDatabaseFiles(path, false);
  afterSidecars?.();
  renameSync(building, path);
  syncDir(dirname(path));
}

const REMINDER_KEY = /^(\d+):reminder:(\d+)$/;
const INCIDENT_KEY = /^(\d+):/;
const MANUAL_KEY = /^manual:(-?\d+):/;

/**
 * Durable delivery ledger: a SQLite database (format 5) in WAL mode with `synchronous = FULL`.
 *
 * Every mutation is one transaction that writes only the rows it changes; memory changes only
 * after the commit. A failed transaction rolls back, throws and leaves memory unchanged.
 * Reads come from a mirror loaded at open. A JSON ledger (format 1 or 2) and a format-3 or
 * format-4 database are migrated at open.
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
  readonly #alerts: AlertMirror;
  #remoteChannels: Map<string, RemoteChannelRow>;
  readonly #resendCommands: Map<string, ResendCommandRow>;
  #isClosed = false;
  /** Set when this open migrated a JSON ledger or a format-3 or format-4 database. */
  readonly migration: LedgerMigration | undefined;

  constructor(path: string, opts: LedgerOptions = {}) {
    this.#path = path;
    this.#now = opts.now ?? Date.now;
    this.#beforeCommit = opts.hooks?.beforeCommit;
    removeDatabaseFiles(`${path}.migrating`, true);
    const header = readHeader(path);
    let loaded: LoadedRows | undefined;
    if (header === undefined) {
      mkdirSync(dirname(path), { recursive: true });
      publish(path, new Map(), emptyAlerts());
      loaded = emptyRows();
    } else if (header !== SQLITE_HEADER) {
      this.migration = this.#migrateJson(opts.hooks);
    } else {
      const probed = this.#probe();
      if ("from" in probed) this.migration = this.#migrateSqlite(probed.from, opts.hooks);
      else loaded = probed.rows;
    }
    const opened = this.#open(loaded);
    this.#db = opened.db;
    this.#channels = opened.channels;
    this.#alerts = opened.alerts;
    this.#remoteChannels = opened.remoteChannels;
    this.#resendCommands = opened.resendCommands;
  }

  #migrateJson(hooks: LedgerOptions["hooks"]): LedgerMigration {
    const bytes = readFileSync(this.#path);
    const data = parseJson(JSON.parse(bytes.toString("utf8")), this.#now(), this.#path);
    const backup = `${this.#path}.v${data.version}.bak`;
    publish(
      this.#path,
      data.channels,
      emptyAlerts(),
      () => {
        writeFileAtomicSync(backup, bytes);
        hooks?.beforePublish?.();
      },
      hooks?.afterSidecars,
    );
    return { from: data.version, entries: data.count, backup };
  }

  /**
   * Format 3 or 4 to 5. The order matters: an older file in WAL mode can hold committed rows
   * only in `<state>-wal`, and the publish removes that file. So the rows are first
   * checkpointed into the main file, and only that file is copied and rebuilt. Format 4 keeps
   * its alert rows; format 3 has none.
   */
  #migrateSqlite(from: 3 | 4, hooks: LedgerOptions["hooks"]): LedgerMigration {
    this.#validate(from);
    checkpoint(this.#path);
    const { channels, alerts } = this.#validate(from);
    const backup = `${this.#path}.v${from}.bak`;
    // The atomic write keeps the mode of an existing file and stats through a symlink.
    unlinkIfPresent(backup);
    writeFileAtomicSync(backup, readFileSync(this.#path), { mode: 0o600 });
    publish(this.#path, channels, alerts, hooks?.beforePublish, hooks?.afterSidecars);
    let count = 0;
    for (const channel of channels.values()) count += channel.entries.size;
    return { from, entries: count, backup };
  }

  /** Validates the file after a migration, unless the caller has already loaded its rows. */
  #open(loaded: LoadedRows | undefined): { db: Database } & LoadedRows {
    const rows = loaded ?? this.#validate(LEDGER_VERSION);
    const db = new Database(this.#path, { create: false, readwrite: true });
    try {
      db.run("PRAGMA journal_mode = WAL");
      db.run("PRAGMA synchronous = FULL");
      return { db, ...rows };
    } catch (err) {
      db.close();
      throw err;
    }
  }

  /**
   * One private copy for an existing SQLite file: the version for format 3 or 4 (to migrate),
   * the validated rows for format 5, and a refusal for any other version.
   */
  #probe(): { from: 3 | 4 } | { rows: LoadedRows } {
    return readSnapshot(this.#path, (db) => {
      const row = db.query("PRAGMA user_version").get();
      const version = isRecord(row) ? row.user_version : undefined;
      if (version === 3 || version === 4) return { from: version };
      return { rows: this.#load(db, LEDGER_VERSION) };
    });
  }

  /**
   * Reads and validates every row on a private copy of the file and its sidecars. Even a
   * read-only connection rewrites `<state>-shm`, and a refused file must keep all its bytes.
   */
  #validate(version: number): LoadedRows {
    return readSnapshot(this.#path, (db) => this.#load(db, version));
  }

  #load(db: Database, version: number): LoadedRows {
    const row = db.query("PRAGMA user_version").get();
    if (!isRecord(row) || row.user_version !== version) throw unsupported(this.#path);
    if (version !== LEDGER_VERSION && !PREVIOUS_VERSIONS.has(version)) {
      throw unsupported(this.#path);
    }
    try {
      const rows = emptyRows();
      rows.channels = loadRows(db, this.#path);
      if (version >= 4) rows.alerts = loadAlerts(db, this.#path);
      if (version === LEDGER_VERSION) {
        rows.remoteChannels = loadTable(db, "remote_channels", readRemoteRow, this.#path);
        rows.resendCommands = loadTable(db, "resend_commands", readResendRow, this.#path);
      }
      return rows;
    } catch (err) {
      throw unsupported(this.#path, { cause: err });
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
    if (isRecord(row) && row.busy !== 0) throw new LedgerCheckpointError();
  }

  /** Closes the database. Every later mutation throws `LedgerClosedError`. */
  close(): void {
    if (this.#isClosed) return;
    this.#isClosed = true;
    this.#db.close();
  }

  /** The persisted database channels of the last applied answer, in row order. */
  remoteChannels(): RemoteChannelRow[] {
    return [...this.#remoteChannels.values()].map((r) => ({ ...r }));
  }

  /**
   * Replaces every `remote_channels` row in one transaction. A row whose definition is not a
   * valid reference-only channel is refused before the write, with no row changed.
   */
  replaceRemoteChannels(rows: readonly RemoteChannelRow[]): void {
    const next = new Map<string, RemoteChannelRow>();
    for (const r of rows) {
      const checked = readRemoteRow({
        id: r.id,
        definition: r.definition,
        revision: r.revision,
        applied_at: r.appliedAt,
      });
      if (checked === undefined || next.has(checked.id)) {
        throw new LedgerRowError(`remote channel row ${JSON.stringify(r.id)} is invalid`);
      }
      next.set(checked.id, checked);
    }
    this.#transact(
      () => {
        this.#db.run("DELETE FROM remote_channels");
        const insert = this.#db.query(
          "INSERT INTO remote_channels (id, definition, revision, applied_at) VALUES (?, ?, ?, ?)",
        );
        for (const r of next.values()) insert.run(r.id, r.definition, r.revision, r.appliedAt);
      },
      () => {
        this.#remoteChannels = next;
      },
    );
  }

  /** The stored resend command rows, in row order. */
  resendCommands(): ResendCommandRow[] {
    return [...this.#resendCommands.values()].map((r) => ({ ...r }));
  }

  /**
   * Deletes finished command rows that the api acknowledged (`posted_state` equals `state`) and
   * that are older than `maxAgeMs`. Unposted and admitted rows stay. Returns the count.
   */
  pruneResendCommands(maxAgeMs: number = RESEND_COMMAND_RETENTION_MS): number {
    const cutoff = this.#now() - maxAgeMs;
    const ids = [...this.#resendCommands.values()]
      .filter((r) => r.state !== "admitted" && r.postedState === r.state && r.updatedAt < cutoff)
      .map((r) => r.id);
    if (ids.length === 0) return 0;
    this.#transact(
      () => {
        const del = this.#db.query("DELETE FROM resend_commands WHERE id = ?");
        for (const id of ids) del.run(id);
      },
      () => {
        for (const id of ids) this.#resendCommands.delete(id);
      },
    );
    return ids.length;
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
        this.#finishCommandRows(channelId, key, status, at);
      },
      () => {
        this.#finishCommandsInMemory(channelId, key, status, at);
        entry.status = status;
        entry.at = at;
        if (!isKept) {
          entry.payload = undefined;
          entry.recipients = undefined;
        }
      },
    );
  }

  // Every terminal entry write calls these in its own transaction (Decision 14).
  #finishCommandRows(channelId: string, key: string, state: ResendCommandState, at: number): void {
    this.#db
      .query(
        "UPDATE resend_commands SET state = ?, updated_at = ? WHERE channel_id = ? AND key = ? AND state = 'admitted'",
      )
      .run(state, at, channelId, key);
  }

  #finishCommandsInMemory(
    channelId: string,
    key: string,
    state: ResendCommandState,
    at: number,
  ): void {
    for (const row of this.#resendCommands.values()) {
      if (row.channelId === channelId && row.key === key && row.state === "admitted") {
        row.state = state;
        row.updatedAt = at;
      }
    }
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
    const plan = this.#resendPlan(channelId, key);
    if (plan.result === "resent") this.#transact(plan.write, plan.apply);
    return plan.result;
  }

  #resendPlan(
    channelId: string,
    key: string,
  ):
    | { result: "resent"; write: () => void; apply: () => void }
    | { result: Exclude<ResendResult, "resent"> } {
    const entry = this.#entry(channelId, key);
    if (entry?.status !== "failed") return { result: "not-failed" };
    if (!entry.payload) return { result: "no-payload" };
    const at = this.#now();
    const recipients = entry.recipients
      ? { delivered: [...entry.recipients.delivered], refused: [] }
      : undefined;
    return {
      result: "resent",
      write: () => {
        this.#db
          .query(
            "UPDATE entries SET status = 'pending', at = ?, recipients = ? WHERE channel_id = ? AND key = ?",
          )
          .run(at, json(recipients), channelId, key);
      },
      apply: () => {
        entry.status = "pending";
        entry.at = at;
        entry.recipients = recipients;
      },
    };
  }

  /**
   * Handles a claimed resend command (Decision 14). A command id that already has a row is never
   * executed again: its stored row comes back with `isNew` false. Otherwise the admission check,
   * the resend of the key and the new row commit in one transaction; the caller enqueues an
   * `admitted` key only after this returns.
   */
  admitResendCommand(
    command: { id: string; channelId: string; key: string },
    isInstalled: boolean,
  ): { row: ResendCommandRow; isNew: boolean } {
    this.#assertOpen();
    const stored = this.#resendCommands.get(command.id);
    if (stored) return { row: { ...stored }, isNew: false };
    const { id, channelId, key } = command;
    const plan = isInstalled
      ? this.#resendPlan(channelId, key)
      : { result: "channel-unavailable" as const };
    const state: ResendCommandState = plan.result === "resent" ? "admitted" : plan.result;
    const row: ResendCommandRow = {
      id,
      channelId,
      key,
      state,
      postedState: undefined,
      updatedAt: this.#now(),
    };
    this.#transact(
      () => {
        if ("write" in plan) plan.write();
        this.#db
          .query(
            "INSERT INTO resend_commands (id, channel_id, key, state, posted_state, updated_at) VALUES (?, ?, ?, ?, NULL, ?)",
          )
          .run(id, channelId, key, state, row.updatedAt);
      },
      () => {
        if ("apply" in plan) plan.apply();
        this.#resendCommands.set(id, row);
      },
    );
    return { row: { ...row }, isNew: true };
  }

  /** Records that the api acknowledged (or finally refused) `state` for the command. */
  markResendPosted(id: string, state: ResendCommandState): void {
    this.#assertOpen();
    const row = this.#resendCommands.get(id);
    if (!row) return;
    this.#transact(
      () => {
        this.#db.query("UPDATE resend_commands SET posted_state = ? WHERE id = ?").run(state, id);
      },
      () => {
        row.postedState = state;
      },
    );
  }

  /** The stored alert state of the subject; `undefined` when there is none. */
  alertState(kind: AlertKind, subjectId: string): AlertState | undefined {
    const state = this.#alerts.get(kind)?.get(subjectId);
    return state ? { ...state } : undefined;
  }

  /** Every stored subject of `kind` with its alert state. */
  alertStates(kind: AlertKind): [string, AlertState][] {
    const rows = this.#alerts.get(kind) ?? new Map<string, AlertState>();
    return [...rows].map(([id, state]) => [id, { ...state }]);
  }

  /**
   * All alert changes of one poll in one transaction: every row upsert and a `pending` entry for
   * every delivery whose channel has no entry with that key. Returns the added deliveries.
   * An empty batch writes nothing. A failed write throws and changes nothing.
   */
  applyAlerts(rows: readonly AlertUpsert[], deliveries: readonly AlertDelivery[]): AlertDelivery[] {
    this.#assertOpen();
    const seen = new Set<string>();
    const added = deliveries.filter((d) => {
      const id = JSON.stringify([d.channelId, d.key]);
      if (seen.has(id) || this.has(d.channelId, d.key)) return false;
      seen.add(id);
      return true;
    });
    if (rows.length === 0 && added.length === 0) return [];
    const at = this.#now();
    this.#transact(
      () => {
        const upsert = this.#db.query(
          `INSERT INTO alert_state (kind, subject_id, last_event_at, stage, episode_at, observed_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (kind, subject_id) DO UPDATE SET last_event_at = excluded.last_event_at,
             stage = excluded.stage, episode_at = excluded.episode_at,
             observed_at = excluded.observed_at, updated_at = excluded.updated_at`,
        );
        for (const { kind, subjectId, state } of rows) {
          upsert.run(
            kind,
            subjectId,
            state.lastEventAt ?? null,
            state.stage ?? null,
            state.episodeAt ?? null,
            state.observedAt ?? null,
            at,
          );
        }
        const insert = this.#db.query(
          "INSERT INTO entries (channel_id, key, status, at, payload) VALUES (?, ?, 'pending', ?, ?)",
        );
        for (const d of added) {
          this.#upsertChannel(d.channelId);
          insert.run(d.channelId, d.key, at, JSON.stringify(d.notification));
        }
      },
      () => {
        for (const { kind, subjectId, state } of rows) {
          this.#alerts.get(kind)?.set(subjectId, {
            lastEventAt: state.lastEventAt,
            stage: state.stage,
            episodeAt: state.episodeAt,
            observedAt: state.observedAt,
            updatedAt: at,
          });
        }
        for (const d of added) {
          this.#channelState(d.channelId).entries.set(d.key, {
            status: "pending",
            at,
            payload: d.notification,
          });
        }
      },
    );
    return added;
  }

  /**
   * Settles as `dropped`, in one transaction, every `pending` entry of the channels whose payload
   * is an incident event or absent (a legacy key). Pending warnings and other statuses stay.
   * Returns the dropped count per given channel. Writes nothing when there is nothing to drop.
   */
  dropPendingIncidents(channelIds: readonly string[]): Map<string, number> {
    this.#assertOpen();
    const targets = new Map<string, string[]>();
    for (const channelId of new Set(channelIds)) {
      const entries = this.#channels.get(channelId)?.entries ?? new Map<string, LedgerEntry>();
      const keys = [...entries]
        .filter(([, e]) => e.status === "pending" && !isWarningPayload(e.payload))
        .map(([key]) => key);
      targets.set(channelId, keys);
    }
    const counts = new Map([...targets].map(([id, keys]) => [id, keys.length]));
    if ([...counts.values()].every((n) => n === 0)) return counts;
    const at = this.#now();
    this.#transact(
      () => {
        const drop = this.#db.query(
          "UPDATE entries SET status = 'dropped', at = ?, payload = NULL, recipients = NULL WHERE channel_id = ? AND key = ?",
        );
        for (const [channelId, keys] of targets) {
          for (const key of keys) {
            drop.run(at, channelId, key);
            this.#finishCommandRows(channelId, key, "dropped", at);
          }
        }
      },
      () => {
        for (const [channelId, keys] of targets) {
          for (const key of keys) {
            this.#finishCommandsInMemory(channelId, key, "dropped", at);
            const entry = this.#entry(channelId, key);
            if (entry)
              Object.assign(entry, {
                status: "dropped",
                at,
                payload: undefined,
                recipients: undefined,
              });
          }
        }
      },
    );
    return counts;
  }

  /**
   * Removes alert rows not changed for `maxAgeMs` whose subject was absent from the last good
   * read of its feed. A kind whose feed had no good read in this run keeps every row.
   * Returns the number of removed rows.
   */
  pruneAlerts(maxAgeMs: number, presence: AlertFeedPresence): number {
    this.#assertOpen();
    const cutoff = this.#now() - maxAgeMs;
    const removed: [AlertKind, string][] = [];
    for (const kind of ALERT_KINDS) {
      const present = kind === "budget-component" ? presence.components : presence.checks;
      if (present === undefined) continue;
      for (const [id, state] of this.#alerts.get(kind) ?? []) {
        if (state.updatedAt < cutoff && !present.has(id)) removed.push([kind, id]);
      }
    }
    if (removed.length === 0) return 0;
    this.#transact(
      () => {
        const del = this.#db.query("DELETE FROM alert_state WHERE kind = ? AND subject_id = ?");
        for (const [kind, id] of removed) del.run(kind, id);
      },
      () => {
        for (const [kind, id] of removed) this.#alerts.get(kind)?.delete(id);
      },
    );
    return removed.length;
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

function isWarningPayload(payload: Notification | undefined): boolean {
  return payload !== undefined && WARNING_EVENTS.has(String(payload.event));
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
