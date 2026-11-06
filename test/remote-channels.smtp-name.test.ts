import { test } from "bun:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.ts";
import { checkChannelsAnswer, resolveDatabaseChannel } from "../src/remote-channels.ts";

test("a database email keeps the SMTP client name validation used by file channels", () => {
  const definition = {
    id: "mail",
    type: "email",
    smtp: { host: "mail.example.com", port: 587, clientName: "mail/invalid" },
    from: "ops@example.com",
    to: ["oncall@example.com"],
  };
  assert.throws(
    () => parseConfig({ channels: [definition] }),
    /smtp.clientName must be a host name or an address literal/,
  );
  const answer = checkChannelsAnswer({
    revision: `sha256-${"1".repeat(64)}`,
    channels: [{ ...definition, createdAt: 1, updatedAt: 2 }],
  });
  assert.equal(answer.kind, "applied");
  if (answer.kind !== "applied") throw new Error("expected a valid envelope");
  const [record] = answer.records;
  assert.ok(record);
  const result = resolveDatabaseChannel(record, {
    env: {},
    secretDir: undefined,
    realpath: (path) => path,
    readFile: () => "",
  });
  assert.equal(result.ok, false, "an invalid SMTP client name must be an id-scoped rejection");
});
