import { test } from "bun:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.ts";
import { checkChannelsAnswer, resolveDatabaseChannel } from "../src/remote-channels.ts";

const email = {
  id: "mail",
  type: "email",
  smtp: { host: "mail.example.com", port: 587 },
  from: "ops@example.com",
  to: ["oncall@example.com"],
};

/** Inputs that the notify-local channel schema refuses for file channels. */
const cases: { name: string; definition: Record<string, unknown>; reason: RegExp }[] = [
  {
    name: "smtp client name",
    definition: { ...email, smtp: { ...email.smtp, clientName: "mail/invalid" } },
    reason: /smtp.clientName must be a host name or an address literal/,
  },
  {
    name: "smtp host with a space",
    definition: { ...email, smtp: { ...email.smtp, host: "mail example.com" } },
    reason: /smtp.host must be a host name/,
  },
  {
    name: "multi-line subject prefix",
    definition: { ...email, subjectPrefix: "a\nb" },
    reason: /subjectPrefix must be a single-line string/,
  },
  {
    name: "non-http status url",
    definition: { ...email, statusUrl: "ftp://example.com" },
    reason: /statusUrl must be a valid http\(s\) url/,
  },
];

for (const { name, definition, reason } of cases) {
  test(`a database channel keeps the file channel rule: ${name}`, () => {
    assert.throws(() => parseConfig({ channels: [definition] }), reason);
    const answer = checkChannelsAnswer({
      revision: `sha256-${"1".repeat(64)}`,
      channels: [{ ...definition, createdAt: 1, updatedAt: 2 }],
    });
    // The contract may already refuse it; then the id is rejected at the element level.
    if (answer.kind !== "applied") throw new Error("expected a valid envelope");
    const [record] = answer.records;
    if (record === undefined) {
      assert.equal(answer.rejected[0]?.channelId, "mail");
      return;
    }
    const result = resolveDatabaseChannel(record, {
      env: {},
      secretDir: undefined,
      realpath: (path) => path,
      readFile: () => "",
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.rejected.channelId, "mail");
    assert.match(result.rejected.reason, reason);
  });
}
