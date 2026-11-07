import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/index.ts";
import { spyLogger, startFakeApi } from "./support.ts";

const TOKEN = "sentinel-real-service-token-01937";

for (const source of ["env", "file"] as const) {
  for (const control of ["\r", "\n"]) {
    test(`security: ${source} token with ${JSON.stringify(control)} never reaches logs`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "notify-token-header-"));
      const api = await startFakeApi();
      const logger = spyLogger();
      const timers: { fn: () => void; ms: number }[] = [];
      const schedule = (fn: () => void, ms: number): (() => void) => {
        timers.push({ fn, ms });
        return () => {};
      };
      const value = `${TOKEN}${control}accidental-second-line`;
      const file = join(dir, "token");
      if (source === "file") writeFileSync(file, value, { mode: 0o600 });
      let running: ReturnType<typeof main> | undefined;
      let startupError: unknown;
      try {
        try {
          running = main(
            {
              PULSE_API_URL: api.url,
              PULSE_NOTIFY_STATE: join(dir, "state.db"),
              ...(source === "env"
                ? { PULSE_NOTIFY_API_TOKEN: value }
                : { PULSE_NOTIFY_API_TOKEN_FILE: file }),
            },
            { logger, channelSchedule: schedule, commandSchedule: schedule },
          );
          await running.listening;
          for (const timer of [...timers]) if (timer.ms === 0) timer.fn();
        } catch (err) {
          startupError = err;
        }
      } finally {
        await running?.stop();
        await api.close();
        rmSync(dir, { recursive: true, force: true });
      }
      const output = JSON.stringify(logger.entries);
      if (startupError instanceof Error) assert.equal(startupError.message.includes(TOKEN), false);
      assert.equal(output.includes(TOKEN), false, output);
    });
  }
}
