export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void;
}

/** Structured JSON lines, by default to stderr. */
export function createLogger(
  write: (line: string) => void = (line) => process.stderr.write(line),
  now: () => number = Date.now,
): Logger {
  return {
    log(level, msg, fields = {}) {
      write(`${JSON.stringify({ time: new Date(now()).toISOString(), level, msg, ...fields })}\n`);
    },
  };
}
