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

/**
 * `subscribers delete <address>` (D18). Runs under the store lock, so only while the service
 * is stopped; a held lock is exit 2. No output line holds the address.
 */
export function runSubscribers(args: readonly string[], deps: SubscribersCliDeps): CliResult {
  if (args.length !== 2 || args[0] !== "delete") return { lines: [SUBSCRIBERS_USAGE], code: 1 };
  const email = normalizeSubscriberEmail(args[1]);
  if (email === undefined) return { lines: [INVALID_ADDRESS_LINE], code: 1 };
  let lock: ReturnType<typeof acquireLock> | undefined;
  let store: SubscriberStore | undefined;
  try {
    lock = acquireLock(deps.storePath, deps.lock);
    store = SubscriberStore.openExisting(deps.storePath);
    const deleted = store?.deleteByEmail(email) ?? 0;
    return { lines: [`deleted ${deleted}`], code: 0 };
  } catch (err) {
    if (!(err instanceof ConfigError || err instanceof StartupError)) throw err;
    return { lines: [`pulse-notify: ${err.message}`], code: 2 };
  } finally {
    store?.close();
    lock?.release();
  }
}
