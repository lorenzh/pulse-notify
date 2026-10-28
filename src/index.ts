import { ConfigError, loadConfigFile, loadSettings } from "./config.ts";
import { Ledger } from "./ledger.ts";
import { createLogger } from "./log.ts";
import { Notifier } from "./notifier.ts";

export const name = "pulse-notify";

export function main(env: Record<string, string | undefined> = process.env): Notifier {
  const settings = loadSettings(env);
  const config = loadConfigFile(settings.configPath);
  const logger = createLogger();
  const notifier = new Notifier({
    config,
    apiUrl: settings.apiUrl,
    ledger: new Ledger(settings.statePath),
    logger,
    pollMs: settings.pollMs,
    retryDelayMs: settings.retryDelayMs,
    timeoutMs: settings.timeoutMs,
  });
  notifier.start();
  logger.log("info", "pulse-notify started", {
    channels: config.channels.map((c) => c.id),
    apiUrl: settings.apiUrl,
  });
  const shutdown = () => {
    notifier.stop();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
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
