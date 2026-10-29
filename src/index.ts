import type { Server } from "node:http";
import { ConfigError, loadConfigFile, loadSettings } from "./config.ts";
import { errorFields } from "./errors.ts";
import { closeHealthServer, createHealthServer } from "./health.ts";
import { Ledger } from "./ledger.ts";
import { createLogger } from "./log.ts";
import { Metrics } from "./metrics.ts";
import { Notifier, type NotifierOptions } from "./notifier.ts";
import { defaultSchedule } from "./timeout.ts";
import type { Schedule } from "./types.ts";

export const name = "pulse-notify";

/** Longest wait for the notifier to stop on SIGINT or SIGTERM. */
export const SHUTDOWN_TIMEOUT_MS = 5000;

export interface Stoppable {
  start(): void;
  stop(): Promise<void>;
}

export interface MainDeps {
  /** Signal source; defaults to the real process. */
  process?: { on(signal: "SIGINT" | "SIGTERM", handler: () => void): unknown };
  exit?: (code: number) => void;
  schedule?: Schedule;
  createNotifier?: (opts: NotifierOptions) => Stoppable;
  /** Where JSON log lines go; defaults to stderr. */
  write?: (line: string) => void;
}

export interface Running extends Stoppable {
  /** Resolves with the health listener port, or `undefined` when it is off. */
  listening: Promise<number | undefined>;
}

function openLedger(path: string): Ledger {
  try {
    return new Ledger(path);
  } catch (err) {
    // A bad state file is a startup problem: one line, exit 2.
    throw new ConfigError(`cannot use state file ${path}: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

export function main(
  env: Record<string, string | undefined> = process.env,
  deps: MainDeps = {},
): Running {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const schedule = deps.schedule ?? defaultSchedule;
  const state: { notifier?: Stoppable; health?: Server; isShuttingDown: boolean } = {
    isShuttingDown: false,
  };
  // Registered before any config or ledger work, so a signal during startup still exits 0.
  const shutdown = (): void => {
    if (state.isShuttingDown) return;
    state.isShuttingDown = true;
    let cancel: () => void = () => {};
    const bound = new Promise<void>((resolve) => {
      cancel = schedule(resolve, SHUTDOWN_TIMEOUT_MS);
    });
    // A failed stop is not fatal: the unfinished keys stay pending in the ledger.
    const stopped = Promise.all([
      state.notifier?.stop().catch(() => {}),
      state.health ? closeHealthServer(state.health) : undefined,
    ]);
    void Promise.race([stopped, bound]).finally(() => {
      cancel();
      exit(0);
    });
  };
  const signals = deps.process ?? process;
  signals.on("SIGINT", shutdown);
  signals.on("SIGTERM", shutdown);

  const settings = loadSettings(env);
  const config = loadConfigFile(settings.configPath);
  const logger = createLogger(deps.write, Date.now, settings.logLevel);
  const ledger = openLedger(settings.statePath);
  const metrics = new Metrics(
    config.channels.map((c) => c.id),
    () => ledger.pending().length,
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
  };
  const notifier = deps.createNotifier ? deps.createNotifier(options) : new Notifier(options);
  state.notifier = notifier;
  let isStarted = false;
  let listening: Promise<number | undefined> = Promise.resolve(undefined);
  if (settings.healthPort !== undefined) {
    const health = createHealthServer({
      notReady: () => {
        if (state.isShuttingDown) return "shutting down";
        return isStarted ? undefined : "starting";
      },
      metrics: () => metrics.render(),
    });
    state.health = health;
    listening = new Promise((resolve) => {
      health.once("error", (err) => {
        logger.log("error", "health listener failed", errorFields(err));
        exit(2);
        resolve(undefined);
      });
      health.listen(settings.healthPort, settings.healthHost, () => {
        const address = health.address();
        resolve(typeof address === "object" && address ? address.port : undefined);
      });
    });
  }
  notifier.start();
  isStarted = true;
  logger.log("info", "pulse-notify started", {
    channels: config.channels.map((c) => c.id),
    apiUrl: settings.apiUrl,
  });
  return Object.assign(notifier, { listening });
}

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`pulse-notify: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
}
