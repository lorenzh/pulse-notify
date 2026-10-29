import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { hostname } from "node:os";
import { ConfigError, loadConfigFile, loadLockLeaseSeconds, loadSettings } from "./config.ts";
import { runFailed } from "./failed-cli.ts";
import { closeHealthServer, createHealthServer } from "./health.ts";
import { Ledger } from "./ledger.ts";
import {
  acquireLock,
  heartbeatIntervalSeconds,
  type LedgerLock,
  type LockDeps,
  LockLostError,
} from "./ledger-lock.ts";
import { createLogger, type Logger } from "./log.ts";
import { Metrics } from "./metrics.ts";
import { Notifier, type NotifierOptions, type PollHealth } from "./notifier.ts";
import { redactUrl } from "./redact.ts";
import { defaultSchedule } from "./timeout.ts";
import type { Schedule } from "./types.ts";

export const name = "pulse-notify";

/** Longest wait for the notifier to stop on SIGINT or SIGTERM. */
export const SHUTDOWN_TIMEOUT_MS = 5000;

export interface Stoppable {
  start(): void;
  stop(): Promise<void>;
  /** Absent in test fakes: the health check then never reports failing polls. */
  pollHealth?(): PollHealth;
}

/** The real clock, host, pid check and token for the state lock. */
export interface LockEnv {
  now: () => number;
  hostname: () => string;
  pid: number;
  isPidAlive: (pid: number) => boolean;
  token: () => string;
}

function isRealPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const realLockEnv: LockEnv = {
  now: Date.now,
  hostname,
  pid: process.pid,
  isPidAlive: isRealPidAlive,
  token: randomUUID,
};

/** A timer that does not keep the process alive. */
const unrefSchedule: Schedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

export interface MainDeps {
  /** Signal source; defaults to the real process. */
  process?: { on(signal: "SIGINT" | "SIGTERM", handler: () => void): unknown };
  exit?: (code: number) => void;
  schedule?: Schedule;
  createNotifier?: (opts: NotifierOptions) => Stoppable;
  /** Where JSON log lines go; defaults to stderr. */
  write?: (line: string) => void;
  /** Where the plain one-line startup error goes; defaults to stderr. */
  writeError?: (line: string) => void;
  /** Longest wait for the notifier to stop; defaults to `SHUTDOWN_TIMEOUT_MS`. */
  shutdownTimeoutMs?: number;
  /** Clock, host name, pid check and token for the state lock; defaults to the real ones. */
  lock?: Partial<LockEnv>;
  /** Timer for the lock heartbeat; defaults to an unreferenced real timer. */
  heartbeatSchedule?: Schedule;
}

export interface Running extends Stoppable {
  /** Resolves with the health listener port, or `undefined` when it is off. */
  listening: Promise<number | undefined>;
}

function errorReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\n")[0] ?? "unknown error";
}

function openLedger(path: string, opts: ConstructorParameters<typeof Ledger>[1]): Ledger {
  try {
    return new Ledger(path, opts);
  } catch (err) {
    // A bad state file is a startup problem: one line, exit 2.
    throw new ConfigError(`cannot use state file ${path}: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

function lockDeps(
  env: Partial<LockEnv> | undefined,
  leaseSeconds: number,
  logger?: Logger,
): LockDeps {
  return { ...realLockEnv, ...env, leaseSeconds, logger };
}

export function main(
  env: Record<string, string | undefined> = process.env,
  deps: MainDeps = {},
): Running {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const schedule = deps.schedule ?? defaultSchedule;
  const writeError = deps.writeError ?? ((line: string) => process.stderr.write(line));
  const logRef: { logger?: Logger } = {};
  const state: {
    notifier?: Stoppable;
    health?: Server;
    ledger?: Ledger | undefined;
    lock?: LedgerLock | undefined;
    isShuttingDown: boolean;
  } = { isShuttingDown: false };
  // Stops the notifier, writes batched ledger changes, then frees the state lock.
  let finishing: Promise<void> | undefined;
  const finish = (): Promise<void> => {
    finishing ??= (async () => {
      await state.notifier?.stop().catch(() => {});
      await state.ledger?.flush().catch((err: unknown) => {
        logRef.logger?.log("error", "ledger flush failed, pending keys are resent", {
          error: errorReason(err),
        });
      });
      state.lock?.release();
    })();
    return finishing;
  };
  // Registered before any config or ledger work, so a signal during startup still exits 0.
  const shutdown = (): void => {
    if (state.isShuttingDown) return;
    state.isShuttingDown = true;
    let cancel: () => void = () => {};
    let isBoundHit = false;
    const bound = new Promise<void>((resolve) => {
      cancel = schedule(() => {
        isBoundHit = true;
        resolve();
      }, deps.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS);
    });
    // A failed stop is not fatal: the unfinished keys stay pending in the ledger.
    const stopped = Promise.all([
      finish(),
      state.health ? closeHealthServer(state.health) : undefined,
    ]);
    void Promise.race([stopped, bound]).finally(() => {
      cancel();
      if (isBoundHit) {
        logRef.logger?.log("warn", "shutdown timed out, exiting", {
          timeoutMs: deps.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS,
        });
        state.lock?.release();
      }
      exit(0);
    });
  };
  const signals = deps.process ?? process;
  signals.on("SIGINT", shutdown);
  signals.on("SIGTERM", shutdown);

  const settings = loadSettings(env);
  const config = loadConfigFile(settings.configPath, {
    env,
    readFile: (path) => readFileSync(path, "utf8"),
  });
  const logger = createLogger(deps.write, Date.now, settings.logLevel);
  logRef.logger = logger;
  const lock = acquireLock(
    settings.statePath,
    lockDeps(deps.lock, settings.lockLeaseSeconds, logger),
  );
  state.lock = lock;
  let ledger: Ledger;
  try {
    ledger = openLedger(settings.statePath, {
      onError: (err) =>
        logger.log("error", "ledger write failed, pending keys are resent", {
          error: errorReason(err),
        }),
    });
  } catch (err) {
    lock.release();
    throw err;
  }
  state.ledger = ledger;
  const notifierRef: { current?: Stoppable } = {};
  const metrics = new Metrics(
    config.channels.map((c) => c.id),
    () => ledger.pending().length,
    () => notifierRef.current?.pollHealth?.().consecutiveFailedPolls ?? 0,
  );
  const options: NotifierOptions = {
    config,
    apiUrl: settings.apiUrl,
    ledger,
    logger,
    metrics,
    pollMs: settings.pollMs,
    retryDelayMs: settings.retryDelayMs,
    retryMaxDelayMs: settings.retryMaxDelayMs,
    retryAttempts: settings.retryAttempts,
    timeoutMs: settings.timeoutMs,
    apiMaxBytes: settings.apiMaxBytes,
    stateRetentionDays: settings.stateRetentionDays,
    smtpClientName: settings.smtpClientName,
    hostname: deps.lock?.hostname ?? hostname,
  };
  const notifier = deps.createNotifier ? deps.createNotifier(options) : new Notifier(options);
  state.notifier = notifier;
  notifierRef.current = notifier;
  startHeartbeat(lock, settings.lockLeaseSeconds, deps.heartbeatSchedule ?? unrefSchedule, {
    logger,
    isStopped: () => state.isShuttingDown,
    onLost: () => {
      // Another process owns the lock now: stop without writing, so two writers never meet.
      state.isShuttingDown = true;
      state.lock = undefined;
      ledger.close();
      state.ledger = undefined;
      void notifier.stop().catch(() => {});
      exit(2);
    },
  });
  let isStarted = false;
  const startNotifier = (): void => {
    notifier.start();
    isStarted = true;
    logger.log("info", "pulse-notify started", {
      channels: config.channels.map((c) => c.id),
      apiUrl: redactUrl(settings.apiUrl),
    });
  };
  let listening: Promise<number | undefined> = Promise.resolve(undefined);
  if (settings.healthPort === undefined) {
    startNotifier();
  } else {
    const { healthHost, healthPort, healthMaxFailedPolls } = settings;
    const health = createHealthServer({
      notReady: () => {
        if (state.isShuttingDown) return "shutting down";
        if (!isStarted) return "starting";
        const failed = notifier.pollHealth?.().consecutiveFailedPolls ?? 0;
        return failed >= healthMaxFailedPolls ? `polls failing (${failed} in a row)` : undefined;
      },
      metrics: () => metrics.render(),
    });
    state.health = health;
    // The notifier starts only once the listener is bound, so a bind error does no service work.
    listening = new Promise((resolve) => {
      health.once("error", (err) => {
        if (!state.isShuttingDown) {
          writeError(
            `pulse-notify: cannot listen on ${healthHost}:${healthPort} (PULSE_HEALTH_HOST/PULSE_HEALTH_PORT): ${errorReason(err)}\n`,
          );
          lock.release();
          exit(2);
        }
        resolve(undefined);
      });
      health.listen(healthPort, healthHost, () => {
        const address = health.address();
        resolve(typeof address === "object" && address ? address.port : undefined);
        if (!state.isShuttingDown) startNotifier();
      });
    });
  }
  const stop = async (): Promise<void> => {
    await Promise.all([finish(), state.health ? closeHealthServer(state.health) : undefined]);
  };
  const running: Running = { start: () => notifier.start(), stop, listening };
  if (notifier.pollHealth) {
    running.pollHealth = () => notifier.pollHealth?.() ?? { consecutiveFailedPolls: 0 };
  }
  return running;
}

interface HeartbeatOptions {
  logger: Logger;
  isStopped: () => boolean;
  onLost: () => void;
}

/** Rewrites the lock heartbeat every lease/6 seconds until the service stops. */
function startHeartbeat(
  lock: LedgerLock,
  leaseSeconds: number,
  schedule: Schedule,
  opts: HeartbeatOptions,
): void {
  const intervalMs = heartbeatIntervalSeconds(leaseSeconds) * 1000;
  const beat = (): void => {
    if (opts.isStopped()) return;
    try {
      lock.heartbeat();
    } catch (err) {
      if (err instanceof LockLostError) {
        opts.logger.log("error", "state lock lost, stopping", { error: err.message });
        opts.onLost();
        return;
      }
      opts.logger.log("warn", "state lock heartbeat failed", { error: errorReason(err) });
    }
    schedule(beat, intervalMs);
  };
  schedule(beat, intervalMs);
}

export interface CliDeps {
  /** Where output lines go; defaults to stdout. */
  write?: (line: string) => void;
  /** Where errors go; defaults to stderr. */
  writeError?: (line: string) => void;
  lock?: Partial<LockEnv>;
  now?: () => number;
}

/**
 * Runs `pulse-notify failed ...` on the state file under its lock and returns the exit code:
 * 0 done, 1 refused or bad request, 2 state file in use or unusable. Starts no service.
 */
export async function runCli(
  args: string[],
  env: Record<string, string | undefined> = process.env,
  deps: CliDeps = {},
): Promise<number> {
  const write = deps.write ?? ((line: string) => process.stdout.write(line));
  const writeError = deps.writeError ?? ((line: string) => process.stderr.write(line));
  const statePath = env.PULSE_NOTIFY_STATE || "./notify-state.json";
  let lock: LedgerLock | undefined;
  try {
    lock = acquireLock(statePath, lockDeps(deps.lock, loadLockLeaseSeconds(env)));
    const ledger = openLedger(statePath, deps.now ? { now: deps.now } : {});
    const result = runFailed(args, ledger);
    await ledger.flush();
    for (const line of result.lines) write(`${line}\n`);
    return result.code;
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    writeError(`pulse-notify: ${err.message}\n`);
    return 2;
  } finally {
    lock?.release();
  }
}

if (import.meta.main) {
  try {
    if (process.argv[2] === "failed") {
      process.exitCode = await runCli(process.argv.slice(3));
    } else {
      main();
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`pulse-notify: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
}
