import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { ConfigError, loadConfigFile, loadSettings } from "./config.ts";
import { closeHealthServer, createHealthServer } from "./health.ts";
import { Ledger } from "./ledger.ts";
import { createLogger, type Logger } from "./log.ts";
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
  /** Where the plain one-line startup error goes; defaults to stderr. */
  writeError?: (line: string) => void;
  /** Longest wait for the notifier to stop; defaults to `SHUTDOWN_TIMEOUT_MS`. */
  shutdownTimeoutMs?: number;
}

export interface Running extends Stoppable {
  /** Resolves with the health listener port, or `undefined` when it is off. */
  listening: Promise<number | undefined>;
}

function errorReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\n")[0] ?? "unknown error";
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
  const writeError = deps.writeError ?? ((line: string) => process.stderr.write(line));
  const logRef: { logger?: Logger } = {};
  const state: { notifier?: Stoppable; health?: Server; isShuttingDown: boolean } = {
    isShuttingDown: false,
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
      state.notifier?.stop().catch(() => {}),
      state.health ? closeHealthServer(state.health) : undefined,
    ]);
    void Promise.race([stopped, bound]).finally(() => {
      cancel();
      if (isBoundHit) {
        logRef.logger?.log("warn", "shutdown timed out, exiting", {
          timeoutMs: deps.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS,
        });
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
  const startNotifier = (): void => {
    notifier.start();
    isStarted = true;
    logger.log("info", "pulse-notify started", {
      channels: config.channels.map((c) => c.id),
      apiUrl: settings.apiUrl,
    });
  };
  let listening: Promise<number | undefined> = Promise.resolve(undefined);
  if (settings.healthPort === undefined) {
    startNotifier();
  } else {
    const { healthHost, healthPort } = settings;
    const health = createHealthServer({
      notReady: () => {
        if (state.isShuttingDown) return "shutting down";
        return isStarted ? undefined : "starting";
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
