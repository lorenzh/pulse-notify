import { createHmac, randomBytes } from "node:crypto";

/**
 * At most one subscriber send in flight per mailbox (D20). Both workers share one guard. Keys
 * are HMAC-SHA256 digests under a random per-process salt, so the map never holds an address.
 */
export interface MailboxGuard {
  /** The mailbox key of a stored (already normalized) address. */
  key: (address: string) => string;
  /** A new owner number and the entry, or `undefined` when the key is held or the guard stops. */
  tryAcquire: (key: string) => number | undefined;
  /** Frees the entry only when `owner` still owns it; any other call does nothing. */
  release: (key: string, owner: number) => void;
  /** Resolves when the entry of `key` settles (at once when there is none), or when `signal` aborts. */
  waitFor: (key: string, signal?: AbortSignal) => Promise<void>;
  size: () => number;
  /** No `tryAcquire` succeeds after this. */
  stop: () => void;
}

interface Entry {
  owner: number;
  settled: Promise<void>;
  resolve: () => void;
}

export function createMailboxGuard(salt: Buffer = randomBytes(32)): MailboxGuard {
  const inFlight = new Map<string, Entry>();
  let lastOwner = 0;
  let isStopping = false;
  return {
    key: (address) => createHmac("sha256", salt).update(address).digest("hex"),
    tryAcquire: (key) => {
      if (isStopping || inFlight.has(key)) return undefined;
      lastOwner += 1;
      let resolve: () => void = () => {};
      const settled = new Promise<void>((r) => {
        resolve = r;
      });
      inFlight.set(key, { owner: lastOwner, settled, resolve });
      return lastOwner;
    },
    release: (key, owner) => {
      const entry = inFlight.get(key);
      if (entry?.owner !== owner) return;
      inFlight.delete(key);
      entry.resolve();
    },
    waitFor: (key, signal) => {
      const entry = inFlight.get(key);
      if (entry === undefined || signal?.aborted === true) return Promise.resolve();
      if (signal === undefined) return entry.settled;
      return new Promise<void>((resolve) => {
        const onAbort = (): void => resolve();
        signal.addEventListener("abort", onAbort, { once: true });
        void entry.settled.then(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        });
      });
    },
    size: () => inFlight.size,
    stop: () => {
      isStopping = true;
    },
  };
}
