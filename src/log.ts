export type LogLevel = "debug" | "info" | "warn" | "error";

export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export interface Logger {
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void;
}

/** Structured JSON lines, by default to stderr. Lines below `minLevel` are dropped. */
export function createLogger(
  write: (line: string) => void = (line) => process.stderr.write(line),
  now: () => number = Date.now,
  minLevel: LogLevel = "info",
): Logger {
  const min = LOG_LEVELS.indexOf(minLevel);
  return {
    log(level, msg, fields = {}) {
      if (LOG_LEVELS.indexOf(level) < min) return;
      write(`${JSON.stringify({ time: new Date(now()).toISOString(), level, msg, ...fields })}\n`);
    },
  };
}
