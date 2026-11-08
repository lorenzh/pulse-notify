import { SQLiteError } from "bun:sqlite";
import { normalizeSubscriberEmail } from "@lorenzh/pulse-contract";
import { StartupError } from "@lorenzh/pulse-kit";
import { ConfigError } from "./config.ts";
import type { CliResult } from "./failed-cli.ts";
import { acquireLock, type LockDeps } from "./ledger-lock.ts";
import { SubscriberStore } from "./subscriber-store.ts";

export const SUBSCRIBERS_USAGE = "usage: pulse-notify subscribers delete <address>";
export const INVALID_ADDRESS_LINE = "pulse-notify: subscribers delete: invalid address";

export interface SubscribersCliDeps {
  /** The store file (`subscriptionStorePath`). */
  storePath: string;
  lock: LockDeps;
}

/** SQLite primary result codes SQLITE_CORRUPT (11) and SQLITE_NOTADB (26). */
const UNREADABLE_STORE_CODES: ReadonlySet<number> = new Set([11, 26]);

function isUnreadableStore(err: unknown): boolean {
  return err instanceof SQLiteError && UNREADABLE_STORE_CODES.has(err.errno & 0xff);
}

/** Escapes a backslash as `\\` and each Cc, U+2028 and U+2029 character as `\uXXXX`. */
function escapePath(path: string): string {
  return path.replace(/[\\\p{Cc}\p{Zl}\p{Zp}]/gu, (ch) =>
    ch === "\\" ? "\\\\" : `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function closeAfterError(store: SubscriberStore): void {
  try {
    store.close();
  } catch {
    // The first error wins: the caller rethrows the delete error instead.
  }
}

function deleteUnderLock(deps: SubscribersCliDeps, email: string): number {
  const lock = acquireLock(deps.storePath, deps.lock);
  try {
    const store = SubscriberStore.openExisting(deps.storePath);
    if (store === undefined) return 0;
    let deleted: number;
    try {
      deleted = store.deleteByEmail(email);
    } catch (err) {
      closeAfterError(store);
      throw err;
    }
    store.close();
    return deleted;
  } finally {
    lock.release();
  }
}

/**
 * `subscribers delete <address>` (D18). Runs under the store lock, so only while the service
 * is stopped; a held lock is exit 2. A store that SQLite reports as corrupt or not a database
 * is exit 2 with one line that names the escaped path. No output line holds the address.
 */
export function runSubscribers(args: readonly string[], deps: SubscribersCliDeps): CliResult {
  if (args.length !== 2 || args[0] !== "delete") return { lines: [SUBSCRIBERS_USAGE], code: 1 };
  const email = normalizeSubscriberEmail(args[1]);
  if (email === undefined) return { lines: [INVALID_ADDRESS_LINE], code: 1 };
  try {
    return { lines: [`deleted ${deleteUnderLock(deps, email)}`], code: 0 };
  } catch (err) {
    if (err instanceof ConfigError || err instanceof StartupError) {
      return { lines: [`pulse-notify: ${err.message}`], code: 2 };
    }
    if (!isUnreadableStore(err)) throw err;
    const shown = escapePath(deps.storePath);
    return {
      lines: [
        `pulse-notify: cannot use subscription store ${shown}: the file is corrupt or not a database`,
      ],
      code: 2,
    };
  }
}
