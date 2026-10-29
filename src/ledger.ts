import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

import type { Notification } from "./types.ts";

/** `dropped`: a reminder that was not sent because its incident resolved first. */
export type LedgerStatus = "seeded" | "pending" | "delivered" | "failed" | "dropped";

interface LedgerData {
  version: 1;
  channels: Record<string, Record<string, LedgerStatus>>;
  /** Notifications of `pending` keys, so they can be resent after a restart. */
  payloads?: Record<string, Record<string, Notification>>;
}

/** Trust boundary: the file content is checked only as far as the ledger relies on it. */
function isLedgerData(value: unknown): value is LedgerData {
  if (typeof value !== "object" || value === null) return false;
  const { version, channels } = value as { version?: unknown; channels?: unknown };
  return version === 1 && typeof channels === "object" && channels !== null;
}

const REMINDER_KEY = /^(\d+):reminder:(\d+)$/;

/** Removes the settled reminder keys of the same incident that are older than `key`. */
function pruneReminders(entries: Record<string, LedgerStatus>, key: string): void {
  const latest = REMINDER_KEY.exec(key);
  if (!latest) return;
  for (const other of Object.keys(entries)) {
    const match = REMINDER_KEY.exec(other);
    if (!match || match[1] !== latest[1]) continue;
    if (Number(match[2]) < Number(latest[2]) && entries[other] !== "pending") delete entries[other];
  }
}

export interface PendingEntry {
  channelId: string;
  key: string;
  /** Absent for entries written by an older version. */
  notification?: Notification;
}

/**
 * Durable delivery ledger: one JSON file, rewritten atomically (temp file + rename).
 * A write that fails throws and leaves the in-memory state as it was.
 */
export class Ledger {
  readonly #path: string;
  #data: LedgerData;

  constructor(path: string) {
    this.#path = path;
    this.#data = this.#load();
  }

  #load(): LedgerData {
    let text: string;
    try {
      text = readFileSync(this.#path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, channels: {} };
      throw err;
    }
    const raw: unknown = JSON.parse(text);
    if (!isLedgerData(raw)) {
      throw new Error(`ledger ${this.#path} has an unsupported format`);
    }
    const parsed = raw;
    if (typeof parsed.payloads !== "object" || !parsed.payloads) delete parsed.payloads;
    return parsed;
  }

  /** Writes `next` to disk, then makes it the current state. */
  #commit(next: LedgerData): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.tmp`;
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, JSON.stringify(next));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.#path);
    this.#data = next;
  }

  hasChannel(channelId: string): boolean {
    return Object.hasOwn(this.#data.channels, channelId);
  }

  status(channelId: string, key: string): LedgerStatus | undefined {
    const entries = this.#data.channels[channelId];
    return entries && Object.hasOwn(entries, key) ? entries[key] : undefined;
  }

  has(channelId: string, key: string): boolean {
    return this.status(channelId, key) !== undefined;
  }

  /** Records the keys as handled without sending; creates the channel record. */
  seed(channelId: string, keys: string[]): void {
    const next = structuredClone(this.#data);
    const entries = next.channels[channelId] ?? {};
    for (const key of keys) {
      if (!Object.hasOwn(entries, key)) entries[key] = "seeded";
    }
    next.channels[channelId] = entries;
    this.#commit(next);
  }

  /**
   * Claims the key as pending before the first send and stores the notification for a resend.
   * False if the key is already recorded.
   */
  claim(channelId: string, key: string, notification: Notification): boolean {
    if (this.has(channelId, key)) return false;
    const next = structuredClone(this.#data);
    const entries = next.channels[channelId] ?? {};
    pruneReminders(entries, key);
    entries[key] = "pending";
    next.channels[channelId] = entries;
    next.payloads ??= {};
    const payloads = next.payloads[channelId] ?? {};
    payloads[key] = notification;
    next.payloads[channelId] = payloads;
    this.#commit(next);
    return true;
  }

  settle(channelId: string, key: string, status: "delivered" | "failed" | "dropped"): void {
    if (this.status(channelId, key) !== "pending") {
      throw new Error(`cannot settle ${channelId}/${key}: not pending`);
    }
    const next = structuredClone(this.#data);
    const entries = next.channels[channelId];
    if (entries) entries[key] = status;
    const payloads = next.payloads?.[channelId];
    if (payloads) delete payloads[key];
    this.#commit(next);
  }

  /** Pending keys in the order they were claimed. */
  pending(): PendingEntry[] {
    const out: PendingEntry[] = [];
    for (const [channelId, entries] of Object.entries(this.#data.channels)) {
      for (const [key, status] of Object.entries(entries)) {
        if (status !== "pending") continue;
        const payloads = this.#data.payloads?.[channelId];
        const notification = payloads && Object.hasOwn(payloads, key) ? payloads[key] : undefined;
        out.push(notification ? { channelId, key, notification } : { channelId, key });
      }
    }
    return out;
  }
}
