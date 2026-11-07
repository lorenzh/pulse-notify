import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getService, sendService } from "../src/api.ts";
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

const accept = (raw: unknown): { ok: true; value: unknown } => ({ ok: true, value: raw });

for (const site of ["getService", "sendService"] as const) {
  for (const control of ["\r", "\n", " ", "\u00e9"]) {
    test(`security: ${site} refuses token with ${JSON.stringify(control)} without echoing it`, async () => {
      let calls = 0;
      const opts = {
        baseUrl: "http://127.0.0.1:9",
        token: `${TOKEN}${control}x`,
        fetch: (async () => {
          calls += 1;
          return new Response("{}");
        }) as unknown as typeof fetch,
      };
      let caught: unknown;
      try {
        if (site === "getService") await getService(opts, "service/notify/channels", accept);
        else await sendService(opts, "PUT", "service/notify/report", {}, accept);
      } catch (err) {
        caught = err;
      }
      assert.ok(caught instanceof Error);
      assert.equal(caught.message, "service token is not a valid header value");
      assert.equal(calls, 0);
    });
  }
}
