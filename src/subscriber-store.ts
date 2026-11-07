import { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync } from "node:fs";
import { SUBSCRIPTION_CLEANUP_INTERVAL_MS } from "@lorenzh/pulse-contract";
import { StartupError } from "@lorenzh/pulse-kit";

export const STORE_VERSION = 1;

const SCHEMA = `
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending','confirmed')),
  created_at INTEGER NOT NULL,
  confirm_digest TEXT UNIQUE,
  confirm_expires_at INTEGER,
  confirm_sends INTEGER NOT NULL,
  last_sent_at INTEGER,
  confirmed_at INTEGER
);
CREATE TABLE events (
  key TEXT PRIMARY KEY,
  manual_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('seeded','pending','done')),
  detected_at INTEGER NOT NULL,
  payload TEXT,
  settled_at INTEGER,
  passes INTEGER NOT NULL DEFAULT 0,
  next_pass_at INTEGER
);
CREATE TABLE deliveries (
  event_key TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent','failed')),
  attempts INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (event_key, subscription_id)
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
PRAGMA user_version = ${STORE_VERSION};
`;

/** Ids of eligible subscriptions are read in pages of this size (R5 "Fan-out"). */
export const ELIGIBLE_PAGE_SIZE = 100;

export type SubscriptionState = "pending" | "confirmed";

export interface SubscriptionRow {
  id: string;
  email: string;
  state: SubscriptionState;
  createdAt: number;
  confirmDigest: string | null;
  confirmExpiresAt: number | null;
  confirmSends: number;
  lastSentAt: number | null;
  confirmedAt: number | null;
}

export type EventStatus = "seeded" | "pending" | "done";

export interface EventRow {
  key: string;
  manualId: number;
  status: EventStatus;
  detectedAt: number;
  payload: string | null;
  settledAt: number | null;
  passes: number;
  nextPassAt: number | null;
}

export interface NewEvent {
  key: string;
  manualId: number;
  payload: string;
}

export type DeliveryStatus = "sent" | "failed";

export interface StoreLogger {
  warn: (message: string, fields?: Record<string, unknown>) => void;
}

export interface CleanupInput {
  now: number;
  retentionMs: number;
  /** Manual ids of the last good manual read; `undefined` before the first one (no event pruned). */
  listedIds: ReadonlySet<number> | undefined;
}

interface SubscriptionRecord {
  id: string;
  email: string;
  state: SubscriptionState;
  created_at: number;
  confirm_digest: string | null;
  confirm_expires_at: number | null;
  confirm_sends: number;
  last_sent_at: number | null;
  confirmed_at: number | null;
}

interface EventRecord {
  key: string;
  manual_id: number;
  status: EventStatus;
  detected_at: number;
  payload: string | null;
  settled_at: number | null;
  passes: number;
  next_pass_at: number | null;
}

function toSubscription(r: SubscriptionRecord): SubscriptionRow {
  return {
    id: r.id,
    email: r.email,
    state: r.state,
    createdAt: r.created_at,
    confirmDigest: r.confirm_digest,
    confirmExpiresAt: r.confirm_expires_at,
    confirmSends: r.confirm_sends,
    lastSentAt: r.last_sent_at,
    confirmedAt: r.confirmed_at,
  };
}

function toEvent(r: EventRecord): EventRow {
  return {
    key: r.key,
    manualId: r.manual_id,
    status: r.status,
    detectedAt: r.detected_at,
    payload: r.payload,
    settledAt: r.settled_at,
    passes: r.passes,
    nextPassAt: r.next_pass_at,
  };
}

const SETTING = "PULSE_NOTIFY_SUBSCRIPTIONS_STATE";

/** The eligibility rule of R5 "Fan-out", shared by the page read and the finalize step. */
const ELIGIBLE = `s.state = 'confirmed' AND s.confirmed_at <= e.detected_at
  AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.event_key = e.key AND d.subscription_id = s.id)`;

/**
 * The subscriber store (R3): SQLite in WAL mode with `synchronous = FULL` and
 * `secure_delete = ON`. Every method is synchronous and every mutation is one transaction.
 * After a transaction that deletes a subscription the WAL is checkpointed with TRUNCATE.
 */
export class SubscriberStore {
  readonly #db: Database;
  readonly #logger: StoreLogger | undefined;
  #needsCheckpoint = false;
  #depth = 0;
  #isCheckpointDeferred = false;

  private constructor(db: Database, logger: StoreLogger | undefined) {
    this.#db = db;
    this.#logger = logger;
  }

  /** Opens or creates the store with mode 0600. A file of another version is refused (exit 2). */
  static open(path: string, opts: { logger?: StoreLogger } = {}): SubscriberStore {
    const isNew = !existsSync(path);
    // SQLite gives its WAL and shm files the mode of the database file, so create it private.
    if (isNew) closeSync(openSync(path, "wx", 0o600));
    const db = new Database(path, { create: false, readwrite: true, strict: true });
    try {
      db.run("PRAGMA journal_mode = WAL");
      db.run("PRAGMA synchronous = FULL");
      db.run("PRAGMA secure_delete = ON");
      const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
      if (version?.user_version === 0 && isNew) {
        db.transaction(() => db.run(SCHEMA))();
      } else if (version?.user_version !== STORE_VERSION) {
        throw new StartupError(`${SETTING}: the store has an unknown format`, {
          setting: SETTING,
        });
      }
    } catch (err) {
      db.close();
      throw err;
    }
    return new SubscriberStore(db, opts.logger);
  }

  /** Opens an existing store; `undefined` when the file does not exist (nothing is created). */
  static openExisting(
    path: string,
    opts: { logger?: StoreLogger } = {},
  ): SubscriberStore | undefined {
    return existsSync(path) ? SubscriberStore.open(path, opts) : undefined;
  }

  /** The per-connection settings of R3, for the startup log. */
  pragmas(): { journalMode: string; synchronous: number; secureDelete: number } {
    const read = (name: string): unknown =>
      Object.values(this.#db.query(`PRAGMA ${name}`).get() ?? {})[0];
    return {
      journalMode: String(read("journal_mode")),
      synchronous: Number(read("synchronous")),
      secureDelete: Number(read("secure_delete")),
    };
  }

  /** Runs `fn` in one transaction; the operations of R5 compose the methods below with it. */
  transaction<T>(fn: () => T): T {
    this.#depth += 1;
    let result: T;
    try {
      result = this.#db.transaction(fn)();
    } finally {
      this.#depth -= 1;
    }
    // A checkpoint inside an open transaction fails with SQLITE_LOCKED, so it waits for the
    // outermost commit. A rollback throws above and leaves the request for the next cleanup.
    if (this.#depth === 0 && this.#isCheckpointDeferred) {
      this.#isCheckpointDeferred = false;
      this.checkpoint();
    }
    return result;
  }

  subscriptionByEmail(email: string): SubscriptionRow | undefined {
    const r = this.#db
      .query<SubscriptionRecord, [string]>("SELECT * FROM subscriptions WHERE email = ?")
      .get(email);
    return r ? toSubscription(r) : undefined;
  }

  subscriptionById(id: string): SubscriptionRow | undefined {
    const r = this.#db
      .query<SubscriptionRecord, [string]>("SELECT * FROM subscriptions WHERE id = ?")
      .get(id);
    return r ? toSubscription(r) : undefined;
  }

  subscriptionByDigest(digest: string): SubscriptionRow | undefined {
    const r = this.#db
      .query<SubscriptionRecord, [string]>("SELECT * FROM subscriptions WHERE confirm_digest = ?")
      .get(digest);
    return r ? toSubscription(r) : undefined;
  }

  counts(): { total: number; pending: number } {
    const r = this.#db
      .query<{ total: number; pending: number | null }, []>(
        "SELECT count(*) AS total, sum(state = 'pending') AS pending FROM subscriptions",
      )
      .get();
    return { total: r?.total ?? 0, pending: r?.pending ?? 0 };
  }

  insertPending(row: {
    id: string;
    email: string;
    now: number;
    digest: string;
    expiresAt: number;
  }): void {
    this.transaction(() => {
      this.#db
        .query(
          `INSERT INTO subscriptions (id, email, state, created_at, confirm_digest,
             confirm_expires_at, confirm_sends, last_sent_at, confirmed_at)
           VALUES (?, ?, 'pending', ?, ?, ?, 1, ?, NULL)`,
        )
        .run(row.id, row.email, row.now, row.digest, row.expiresAt, row.now);
    });
  }

  /** A new confirmation link for a `pending` row (R5 Subscribe step 4). */
  renewPending(id: string, next: { now: number; digest: string; expiresAt: number }): boolean {
    return this.transaction(
      () =>
        this.#db
          .query(
            `UPDATE subscriptions SET confirm_digest = ?, confirm_expires_at = ?,
               confirm_sends = confirm_sends + 1, last_sent_at = ?
             WHERE id = ? AND state = 'pending'`,
          )
          .run(next.digest, next.expiresAt, next.now, id).changes === 1,
    );
  }

  /** `pending` → `confirmed`; false when the row is not `pending`. */
  confirm(id: string, now: number): boolean {
    return this.transaction(
      () =>
        this.#db
          .query(
            "UPDATE subscriptions SET state = 'confirmed', confirmed_at = ? WHERE id = ? AND state = 'pending'",
          )
          .run(now, id).changes === 1,
    );
  }

  /** Deletes a subscription and its delivery rows, then checkpoints. True when a row was deleted. */
  deleteSubscription(id: string): boolean {
    const deleted = this.transaction(() => this.#deleteIds([id]));
    if (deleted.length > 0) this.checkpoint();
    return deleted.length > 0;
  }

  /** Deletes the row of an already normalized address (D18); the deleted count, 0 or 1. */
  deleteByEmail(email: string): number {
    const deleted = this.transaction(() => {
      const row = this.#db
        .query<{ id: string }, [string]>("SELECT id FROM subscriptions WHERE email = ?")
        .get(email);
      return row ? this.#deleteIds([row.id]) : [];
    });
    if (deleted.length > 0) this.checkpoint();
    return deleted.length;
  }

  #deleteIds(ids: readonly string[]): string[] {
    const out: string[] = [];
    const rows = this.#db.query("DELETE FROM subscriptions WHERE id = ?");
    const deliveries = this.#db.query("DELETE FROM deliveries WHERE subscription_id = ?");
    for (const id of ids) {
      deliveries.run(id);
      if (rows.run(id).changes === 1) out.push(id);
    }
    return out;
  }

  metaValue(key: string): string | undefined {
    return (
      this.#db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)
        ?.value ?? undefined
    );
  }

  hasEvent(key: string): boolean {
    return this.#db.query("SELECT 1 FROM events WHERE key = ?").get(key) !== null;
  }

  event(key: string): EventRow | undefined {
    const r = this.#db.query<EventRecord, [string]>("SELECT * FROM events WHERE key = ?").get(key);
    return r ? toEvent(r) : undefined;
  }

  /** The first detection: every key `seeded` and `manual_baseline_at` set, in one transaction. */
  seedEvents(events: readonly { key: string; manualId: number }[], now: number): void {
    this.transaction(() => {
      const insert = this.#db.query(
        "INSERT OR IGNORE INTO events (key, manual_id, status, detected_at) VALUES (?, ?, 'seeded', ?)",
      );
      for (const e of events) insert.run(e.key, e.manualId, now);
      this.#db
        .query("INSERT OR REPLACE INTO meta (key, value) VALUES ('manual_baseline_at', ?)")
        .run(String(now));
    });
  }

  /** New events as `pending`, all in one transaction. */
  addPendingEvents(events: readonly NewEvent[], now: number): void {
    this.transaction(() => {
      const insert = this.#db.query(
        "INSERT OR IGNORE INTO events (key, manual_id, status, detected_at, payload) VALUES (?, ?, 'pending', ?, ?)",
      );
      for (const e of events) insert.run(e.key, e.manualId, now, e.payload);
    });
  }

  /** Pending events in fan-out order: `detected_at`, then `key`. */
  pendingEvents(): EventRow[] {
    return this.#db
      .query<EventRecord, []>(
        "SELECT * FROM events WHERE status = 'pending' ORDER BY detected_at, key",
      )
      .all()
      .map(toEvent);
  }

  /** Ids (no address) of eligible subscriptions after `afterId`, in pages by id. */
  eligibleIds(eventKey: string, afterId = "", limit = ELIGIBLE_PAGE_SIZE): string[] {
    return this.#db
      .query<{ id: string }, [string, string, number]>(
        `SELECT s.id FROM subscriptions s JOIN events e ON e.key = ?
         WHERE s.id > ? AND ${ELIGIBLE} ORDER BY s.id LIMIT ?`,
      )
      .all(eventKey, afterId, limit)
      .map((r) => r.id);
  }

  /** Starts a pass: `passes + 1`, committed before the first send. Returns the new count. */
  startPass(eventKey: string): number {
    return this.transaction(() => {
      this.#db.query("UPDATE events SET passes = passes + 1 WHERE key = ?").run(eventKey);
      return this.event(eventKey)?.passes ?? 0;
    });
  }

  setNextPassAt(eventKey: string, at: number): void {
    this.transaction(() => {
      this.#db.query("UPDATE events SET next_pass_at = ? WHERE key = ?").run(at, eventKey);
    });
  }

  markDone(eventKey: string, now: number): void {
    this.transaction(() => {
      this.#db
        .query("UPDATE events SET status = 'done', settled_at = ? WHERE key = ?")
        .run(now, eventKey);
    });
  }

  /**
   * The finalize step (R5 "Pass budget" 1): `failed` rows for every current eligible
   * subscription and the event `done`, in one transaction. Returns the rows written.
   */
  finalizeEvent(eventKey: string, now: number): number {
    return this.transaction(() => {
      const written = this.#db
        .query(
          `INSERT INTO deliveries (event_key, subscription_id, status, attempts, at)
           SELECT e.key, s.id, 'failed', e.passes, ? FROM subscriptions s JOIN events e ON e.key = ?
           WHERE ${ELIGIBLE}`,
        )
        .run(now, eventKey).changes;
      this.#db
        .query("UPDATE events SET status = 'done', settled_at = ? WHERE key = ?")
        .run(now, eventKey);
      return written;
    });
  }

  /**
   * The completion write (D21): inserts only while the subscription exists. False when it
   * inserted nothing (the row was deleted while the send was in flight).
   */
  completeDelivery(d: {
    eventKey: string;
    subscriptionId: string;
    status: DeliveryStatus;
    attempts: number;
    at: number;
  }): boolean {
    return this.transaction(
      () =>
        this.#db
          .query(
            `INSERT INTO deliveries (event_key, subscription_id, status, attempts, at)
             SELECT ?1, ?2, ?3, ?4, ?5
             WHERE EXISTS (SELECT 1 FROM subscriptions WHERE id = ?2)`,
          )
          .run(d.eventKey, d.subscriptionId, d.status, d.attempts, d.at).changes === 1,
    );
  }

  /**
   * Cleanup (R3): deletes expired `pending` rows and old settled events that the last good
   * manual read no longer lists. Returns the deleted subscription ids, so the caller cancels
   * their queued jobs at once.
   */
  cleanup(input: CleanupInput): string[] {
    const deleted = this.transaction(() => {
      const ids = this.#db
        .query<{ id: string }, [number]>(
          "SELECT id FROM subscriptions WHERE state = 'pending' AND confirm_expires_at <= ?",
        )
        .all(input.now)
        .map((r) => r.id);
      const removed = this.#deleteIds(ids);
      if (input.listedIds !== undefined) this.#pruneEvents(input);
      return removed;
    });
    if (deleted.length > 0 || this.#needsCheckpoint) this.checkpoint();
    return deleted;
  }

  #pruneEvents(input: CleanupInput): void {
    const cutoff = input.now - input.retentionMs;
    const old = this.#db
      .query<{ key: string; manual_id: number }, [number]>(
        `SELECT key, manual_id FROM events
         WHERE (status = 'done' AND settled_at < ?1) OR (status = 'seeded' AND detected_at < ?1)`,
      )
      .all(cutoff);
    const events = this.#db.query("DELETE FROM events WHERE key = ?");
    const deliveries = this.#db.query("DELETE FROM deliveries WHERE event_key = ?");
    for (const e of old) {
      if (input.listedIds?.has(e.manual_id) === true) continue;
      deliveries.run(e.key);
      events.run(e.key);
    }
  }

  /** `wal_checkpoint(TRUNCATE)`; false and a warning (no address) when it was busy. */
  checkpoint(): boolean {
    if (this.#depth > 0) {
      this.#isCheckpointDeferred = true;
      this.#needsCheckpoint = true;
      return false;
    }
    const r = this.#db.query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get();
    const isDone = r?.busy === 0;
    this.#needsCheckpoint = !isDone;
    if (!isDone)
      this.#logger?.warn("subscriber store checkpoint busy; retried at the next cleanup");
    return isDone;
  }

  /** Checkpoints and closes. */
  close(): void {
    this.checkpoint();
    this.#db.close();
  }
}

export interface CleanupTimerDeps {
  store: SubscriberStore;
  now: () => number;
  retentionMs: number;
  listedIds: () => ReadonlySet<number> | undefined;
  /** Gets the ids that cleanup deleted, right after the commit (queue cancellation, D19). */
  onDeleted: (ids: readonly string[]) => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  logError: (message: string, fields?: Record<string, unknown>) => void;
}

export interface CleanupTimer {
  stop: () => void;
}

/**
 * Runs cleanup once now and then every `SUBSCRIPTION_CLEANUP_INTERVAL_MS` on its own timer,
 * independent of polls.
 */
export function startCleanup(deps: CleanupTimerDeps): CleanupTimer {
  let handle: unknown;
  let isStopped = false;
  const run = (): void => {
    try {
      const ids = deps.store.cleanup({
        now: deps.now(),
        retentionMs: deps.retentionMs,
        listedIds: deps.listedIds(),
      });
      if (ids.length > 0) deps.onDeleted(ids);
    } catch (err) {
      deps.logError("subscriber cleanup failed", {
        error: err instanceof Error ? err.name : "unknown",
      });
    }
    if (!isStopped) handle = deps.setTimeout(run, SUBSCRIPTION_CLEANUP_INTERVAL_MS);
  };
  run();
  return {
    stop: () => {
      isStopped = true;
      deps.clearTimeout(handle);
    },
  };
}
