import { test } from "bun:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomicSync } from "@lorenzh/pulse-kit";
import { Ledger } from "../src/ledger.ts";
import type { Notification } from "../src/types.ts";

const notification: Notification = {
  key: "1:opened",
  event: "opened",
  incidentId: 1,
  checkId: "internal",
  checkName: "Private internal check",
  reason: "PRIVATE_NOTIFICATION_MARKER",
  time: "2026-01-01T00:00:00.000Z",
  timeMs: 0,
  openedMs: 0,
};

for (const isMigration of [true, false]) {
  test(`security: ${isMigration ? "migrated" : "fresh"} ledger keeps notification files private`, () => {
    const dir = mkdtempSync(join(tmpdir(), "notify-permissions-"));
    chmodSync(dir, 0o755);
    const path = join(dir, "state.json");
    let ledger: Ledger | undefined;
    try {
      if (isMigration) {
        writeFileAtomicSync(
          path,
          JSON.stringify({
            version: 2,
            channels: { mail: { "1:opened": { status: "pending", at: 0 } } },
            payloads: { mail: { "1:opened": notification } },
          }),
        );
        assert.equal(statSync(path).mode & 0o777, 0o600);
      }
      ledger = new Ledger(path, { now: () => 0 });
      if (!isMigration) ledger.claim("mail", notification.key, notification);
      ledger.setRecipients("mail", notification.key, {
        delivered: ["private-recipient@example.test"],
        refused: [],
      });
      const files = [path, `${path}-wal`, `${path}-shm`];
      const modes = files.map((file) => (statSync(file).mode & 0o777).toString(8));
      const hasPrivatePayload = files.some((file) =>
        readFileSync(file).includes(Buffer.from("PRIVATE_NOTIFICATION_MARKER")),
      );
      console.log(JSON.stringify({ isMigration, modes, hasPrivatePayload }));
      assert.equal(hasPrivatePayload, true);
      for (const file of files) {
        assert.equal(statSync(file).mode & 0o077, 0, `${file} must not be group/world readable`);
      }
    } finally {
      ledger?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
