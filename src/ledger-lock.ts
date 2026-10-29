import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ConfigError } from "./config.ts";
import type { Logger } from "./log.ts";

/** Seconds between heartbeats for a lease. */
export function heartbeatIntervalSeconds(leaseSeconds: number): number {
  return leaseSeconds / 6;
}

export class LockLostError extends Error {
  constructor(path: string) {
    super(`lock ${path} is held by another process now`);
    this.name = "LockLostError";
  }
}

export interface LockDeps {
  now: () => number;
  hostname: () => string;
  pid: number;
  /** True when a process with this pid runs on this host. */
  isPidAlive: (pid: number) => boolean;
  leaseSeconds: number;
  logger?: Logger | undefined;
  /** A new random token per lock holder. */
  token: () => string;
  /** Age in ms after which a takeover marker counts as left by a crashed takeover. Default 10 s. */
  markerStaleMs?: number;
  /** Test only: called after the first holder read, before the takeover decision. */
  afterHolderRead?: () => void;
  /** Test only: called after the takeover marker is taken, before the lock file is removed. */
  afterMarker?: () => void;
}

const MARKER_STALE_MS = 10_000;

interface LockContent {
  pid: number;
  hostname: string;
  token: string;
  /** Epoch milliseconds of the holder's last heartbeat. */
  heartbeat: number;
}

/** Trust boundary: the lock file is written by another process. */
function parseContent(text: string): LockContent | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // A file that is not JSON is "corrupt"; the caller treats that as a live lock.
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const { pid, hostname, token, heartbeat } = raw as Record<string, unknown>;
  if (
    typeof pid !== "number" ||
    typeof hostname !== "string" ||
    typeof token !== "string" ||
    typeof heartbeat !== "number"
  ) {
    return undefined;
  }
  return { pid, hostname, token, heartbeat };
}

/** What the lock file holds: nothing (no file), something unreadable, or a holder. */
type LockRead =
  | { state: "missing" }
  | { state: "corrupt" }
  | { state: "held"; content: LockContent };

function readContent(path: string): LockRead {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "missing" }
      : { state: "corrupt" };
  }
  const content = parseContent(text);
  return content ? { state: "held", content } : { state: "corrupt" };
}

/** The holder of a lock file, or `undefined` when it is missing or unreadable. */
function holderOf(read: LockRead): LockContent | undefined {
  return read.state === "held" ? read.content : undefined;
}

/** A held lock. Release it on a clean exit; the service calls `heartbeat()` on a timer. */
export class LedgerLock {
  readonly #path: string;
  readonly #deps: LockDeps;
  readonly #content: LockContent;

  constructor(path: string, deps: LockDeps, content: LockContent) {
    this.#path = path;
    this.#deps = deps;
    this.#content = content;
  }

  /** Rewrites the heartbeat. Throws `LockLostError` when the file belongs to someone else. */
  heartbeat(): void {
    if (holderOf(readContent(this.#path))?.token !== this.#content.token) {
      throw new LockLostError(this.#path);
    }
    this.#content.heartbeat = this.#deps.now();
    const tmp = `${this.#path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.#content));
    renameSync(tmp, this.#path);
  }

  owns(token: string): boolean {
    return token === this.#content.token;
  }

  /** Removes the lock file if it is still ours. */
  release(): void {
    if (holderOf(readContent(this.#path))?.token !== this.#content.token) return;
    removeFile(this.#path);
  }
}

function inUse(path: string, holder: LockContent | undefined, nowMs: number): ConfigError {
  if (!holder) {
    return new ConfigError(
      `state file lock ${path} cannot be read (remove it if no pulse-notify runs)`,
    );
  }
  const age = Math.max(0, Math.round((nowMs - holder.heartbeat) / 1000));
  return new ConfigError(
    `state file ${path.replace(/\.lock$/, "")} is in use by ${holder.hostname} pid ${holder.pid} (heartbeat ${age}s ago; remove ${path} if no pulse-notify runs)`,
  );
}

/**
 * Whether the lock of `holder` is dead. Order of the rules:
 * 1. Unreadable or corrupt content is live: never guess.
 * 2. Same host: dead when the pid is gone, or when it is our own pid (a restarted container
 *    reuses its host name and pid, and a new process cannot be its own predecessor).
 * 3. Another host: its pid cannot be checked, so only a heartbeat older than the lease is stale.
 */
function isStale(holder: LockContent | undefined, deps: LockDeps): boolean {
  if (!holder) return false;
  if (holder.hostname === deps.hostname()) {
    return holder.pid === deps.pid || !deps.isPidAlive(holder.pid);
  }
  return deps.now() - holder.heartbeat >= deps.leaseSeconds * 1000;
}

/** Creates the lock file; `undefined` when it exists already. */
function create(path: string, deps: LockDeps): LedgerLock | undefined {
  const content: LockContent = {
    pid: deps.pid,
    hostname: deps.hostname(),
    token: deps.token(),
    heartbeat: deps.now(),
  };
  try {
    writeFileSync(path, JSON.stringify(content), { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw err;
  }
  return new LedgerLock(path, deps, content);
}

interface MarkerContent {
  pid: number;
  hostname: string;
  token: string;
  at: number;
}

/** Trust boundary: the marker is written by another process. */
function parseMarker(text: string): MarkerContent | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Not JSON: the caller treats the marker as live.
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const { pid, hostname, token, at } = raw as Record<string, unknown>;
  if (
    typeof pid !== "number" ||
    typeof hostname !== "string" ||
    typeof token !== "string" ||
    typeof at !== "number"
  ) {
    return undefined;
  }
  return { pid, hostname, token, at };
}

function markerError(marker: string, lockPath: string): ConfigError {
  return new ConfigError(
    `another pulse-notify is taking over the state lock ${lockPath} (remove ${marker} if no pulse-notify runs)`,
  );
}

function readMarkerText(marker: string): string | undefined {
  try {
    return readFileSync(marker, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Writes the marker with `wx`; false when it exists. */
function createMarker(marker: string, deps: LockDeps): string | undefined {
  const token = deps.token();
  const content: MarkerContent = {
    pid: deps.pid,
    hostname: deps.hostname(),
    token,
    at: deps.now(),
  };
  try {
    writeFileSync(marker, JSON.stringify(content), { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw err;
  }
  return token;
}

function isMarkerStale(content: MarkerContent | undefined, deps: LockDeps): boolean {
  if (!content) return false;
  if (deps.now() - content.at >= (deps.markerStaleMs ?? MARKER_STALE_MS)) return true;
  return content.hostname === deps.hostname() && !deps.isPidAlive(content.pid);
}

/**
 * Takes the takeover marker. A stale marker (crashed takeover) is removed once and `wx` retried.
 * Returns the marker token, or throws `ConfigError` when another takeover is live or unreadable.
 */
function takeMarker(marker: string, lockPath: string, deps: LockDeps): string {
  const token = createMarker(marker, deps);
  if (token) return token;
  const text = readMarkerText(marker);
  if (text !== undefined) {
    if (!isMarkerStale(parseMarker(text), deps)) throw markerError(marker, lockPath);
    // Remove only the content we judged stale; a fresh marker of another contender stays.
    if (readMarkerText(marker) === text) removeFile(marker);
  }
  const retry = createMarker(marker, deps);
  if (!retry) throw markerError(marker, lockPath);
  return retry;
}

function releaseMarker(marker: string, token: string): void {
  const text = readMarkerText(marker);
  const content = text === undefined ? undefined : parseMarker(text);
  if (content?.token === token) removeFile(marker);
}

/** Takes over the stale lock under the marker; the caller holds the marker. */
function takeOver(path: string, deps: LockDeps): LedgerLock {
  const fresh = readContent(path);
  if (fresh.state === "missing") {
    const created = create(path, deps);
    if (created) return created;
    throw inUse(path, holderOf(readContent(path)), deps.now());
  }
  const holder = holderOf(fresh);
  if (!isStale(holder, deps)) throw inUse(path, holder, deps.now());
  deps.afterMarker?.();
  deps.logger?.log("warn", "taking over a stale state lock", {
    path,
    ...(holder ? { holderHostname: holder.hostname, holderPid: holder.pid } : {}),
  });
  removeFile(path);
  const taken = create(path, deps);
  const confirmed = holderOf(readContent(path));
  if (!taken || !confirmed || !taken.owns(confirmed.token)) {
    throw inUse(path, confirmed, deps.now());
  }
  return taken;
}

function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === "string";
}

/**
 * Takes the lock `<statePath>.lock` or throws a `ConfigError` (exit 2) when a live process holds it
 * or the path cannot be used. The parent directory is created first. A stale lock is replaced
 * under the marker `<statePath>.lock.takeover`, so only one contender takes over.
 */
export function acquireLock(statePath: string, deps: LockDeps): LedgerLock {
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    return acquire(statePath, deps);
  } catch (err) {
    if (err instanceof ConfigError || !isErrno(err)) throw err;
    throw new ConfigError(`cannot use state file ${statePath}: ${err.message.split("\n")[0]}`, {
      cause: err,
    });
  }
}

function acquire(statePath: string, deps: LockDeps): LedgerLock {
  const path = `${statePath}.lock`;
  const first = create(path, deps);
  if (first) return first;
  const read = readContent(path);
  if (read.state === "missing") {
    // Removed between our two calls: one more try.
    const retry = create(path, deps);
    if (retry) return retry;
    throw inUse(path, holderOf(readContent(path)), deps.now());
  }
  const holder = holderOf(read);
  deps.afterHolderRead?.();
  if (!isStale(holder, deps)) throw inUse(path, holder, deps.now());
  const marker = `${path}.takeover`;
  const markerToken = takeMarker(marker, path, deps);
  try {
    return takeOver(path, deps);
  } finally {
    releaseMarker(marker, markerToken);
  }
}

function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    // A racing process removed it first; the create that follows decides who wins.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
