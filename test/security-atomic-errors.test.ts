import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, nodeAtomicWriteSyncFs } from "@lorenzh/pulse-kit";
import { ChannelDelivery } from "../src/delivery.ts";
import { Ledger } from "../src/ledger.ts";
import type { Notification } from "../src/types.ts";

const notification: Notification = {
  key: "1:opened",
  event: "opened",
  incidentId: 1,
  checkId: "c",
  checkName: "C",
  reason: null,
  time: "2026-01-01T00:00:00.000Z",
  timeMs: 0,
  openedMs: 0,
};

for (const stage of ["write", "rename", "sync-dir"] as const) {
  test(`atomic ${stage} failure does not expose its raw cause in delivery logs`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "notify-security-"));
    const lines: string[] = [];
    const fault = Object.assign(new Error("secret-sentinel: private filesystem text"), {
      code: "EIO",
    });
    const ledger = new Ledger(join(dir, "state.json"), {
      now: () => 0,
      schedule: () => () => {},
      fs: {
        sync: {
          ...nodeAtomicWriteSyncFs,
          open: (path, flags, mode) => {
            if (stage === "write" && flags === "wx") throw fault;
            if (stage === "sync-dir" && flags === "r") throw fault;
            return nodeAtomicWriteSyncFs.open(path, flags, mode);
          },
          rename: (from, to) => {
            if (stage === "rename") throw fault;
            nodeAtomicWriteSyncFs.rename(from, to);
          },
        },
      },
    });
    let sends = 0;
    const delivery = new ChannelDelivery({
      channelId: "ch",
      ledger,
      logger: createLogger({ now: () => 0, write: (_level, line) => lines.push(line) }),
      send: async () => {
        sends++;
      },
      sleep: async () => {},
      retryDelayMs: 0,
    });
    try {
      delivery.enqueue(notification);
      await delivery.idle();
      assert.equal(sends, 0);
      assert.equal(ledger.status("ch", notification.key), undefined);
      assert.equal(lines.length, 1);
      assert.ok(lines[0]?.includes(`atomic write failed at ${stage} (EIO)`));
      assert.doesNotMatch(lines.join("\n"), /secret-sentinel/);
    } finally {
      delivery.stop();
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
