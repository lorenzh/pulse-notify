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

export type LedgerStatus = "seeded" | "pending" | "delivered" | "failed";

interface LedgerData {
  version: 1;
  channels: Record<string, Record<string, LedgerStatus>>;
}

/** Durable delivery ledger: one JSON file, rewritten atomically (temp file + rename). */
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
    const parsed = JSON.parse(text) as LedgerData;
    if (parsed?.version !== 1 || typeof parsed.channels !== "object" || !parsed.channels) {
      throw new Error(`ledger ${this.#path} has an unsupported format`);
    }
    return parsed;
  }

  #save(): void {
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
    const entries = this.#data.channels[channelId] ?? {};
    for (const key of keys) {
      if (!Object.hasOwn(entries, key)) entries[key] = "seeded";
    }
    this.#data.channels[channelId] = entries;
    this.#save();
  }

  /** Claims the key as pending before the first send. False if it is already recorded. */
  claim(channelId: string, key: string): boolean {
    if (this.has(channelId, key)) return false;
    const entries = this.#data.channels[channelId] ?? {};
    entries[key] = "pending";
    this.#data.channels[channelId] = entries;
    this.#save();
    return true;
  }

  settle(channelId: string, key: string, status: "delivered" | "failed"): void {
    const entries = this.#data.channels[channelId];
    if (!entries || entries[key] !== "pending") {
      throw new Error(`cannot settle ${channelId}/${key}: not pending`);
    }
    entries[key] = status;
    this.#save();
  }

  pending(): { channelId: string; key: string }[] {
    const out: { channelId: string; key: string }[] = [];
    for (const [channelId, entries] of Object.entries(this.#data.channels)) {
      for (const [key, status] of Object.entries(entries)) {
        if (status === "pending") out.push({ channelId, key });
      }
    }
    return out;
  }
}
