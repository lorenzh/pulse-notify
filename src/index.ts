import { ConfigError, loadConfigFile, loadSettings } from "./config.ts";
import { Ledger } from "./ledger.ts";
import { createLogger } from "./log.ts";
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
  process?: { once(signal: "SIGINT" | "SIGTERM", handler: () => void): unknown };
  exit?: (code: number) => void;
  schedule?: Schedule;
  createNotifier?: (opts: NotifierOptions) => Stoppable;
}

export function main(
  env: Record<string, string | undefined> = process.env,
  deps: MainDeps = {},
): Stoppable {
  const settings = loadSettings(env);
  const config = loadConfigFile(settings.configPath);
  const logger = createLogger();
  const options: NotifierOptions = {
    config,
    apiUrl: settings.apiUrl,
    ledger: new Ledger(settings.statePath),
    logger,
    pollMs: settings.pollMs,
    retryDelayMs: settings.retryDelayMs,
    retryMaxDelayMs: settings.retryMaxDelayMs,
    retryAttempts: settings.retryAttempts,
    timeoutMs: settings.timeoutMs,
  };
  const notifier = deps.createNotifier ? deps.createNotifier(options) : new Notifier(options);
  notifier.start();
  logger.log("info", "pulse-notify started", {
    channels: config.channels.map((c) => c.id),
    apiUrl: settings.apiUrl,
  });
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const schedule = deps.schedule ?? defaultSchedule;
  const shutdown = (): void => {
    let cancel: () => void = () => {};
    const bound = new Promise<void>((resolve) => {
      cancel = schedule(resolve, SHUTDOWN_TIMEOUT_MS);
    });
    // A failed stop is not fatal: the unfinished keys stay pending in the ledger.
    const stopped = notifier.stop().catch(() => {});
    void Promise.race([stopped, bound]).finally(() => {
      cancel();
      exit(0);
    });
  };
  const signals = deps.process ?? process;
  signals.once("SIGINT", shutdown);
  signals.once("SIGTERM", shutdown);
  return notifier;
}

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`configuration error: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
}
