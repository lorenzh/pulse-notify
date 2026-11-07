import { afterAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateNotifyChannelDefinition } from "@lorenzh/pulse-contract";
import { channelSchema } from "../src/channel-schema.ts";
import { Ledger } from "../src/ledger.ts";
import { checkChannelsAnswer } from "../src/remote-channels.ts";

// Expected values are the literal "notify 0464b90" column of the spec's R2/R3 table (#815).
const base = {
  id: "mail",
  type: "email",
  smtp: { host: "smtp.test", port: 587 },
  from: "pulse@x.test",
  to: ["ops@x.test"],
};

const addressRows: [string, boolean][] = [
  ["Ops <ops@example.test>", true],
  ["Ops < ops@example.test >", true],
  ["Ops <ops@example.test> trailing", false],
  ["  ops@example.test  ", true],
  ["Ops <ops@example.test>  ", true],
  ["ops@example.test\r\n", false],
  ["Ops <>", false],
];

const clientNameRows: [string, boolean][] = [
  ["pulse.example.test", true],
  ["[192.0.2.1]", true],
  ["[IPv6:2001:db8::1]", true],
  ["localhost", true],
  ["pulse_console", false],
  ["☃", false],
  ["☃.example.test", false],
  ["münchen.test", false],
  ["pülse.example.test", false],
  ["pulse\u0000.example.test", false],
  ["-pulse.test", false],
  ["pulse..test", false],
  ["pulse.example.test.", false],
  ["[]", false],
  ["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", false],
  ["", false],
  ["a b", false],
];

function assertParity(input: Record<string, unknown>, expected: boolean): void {
  const schema = channelSchema("email");
  if (schema === undefined) throw new Error("no email schema");
  assert.equal(schema.safeParse(input).success, expected, "notify");
  assert.equal(validateNotifyChannelDefinition(input).ok, expected, "contract");
}

describe("notify and contract agree on email channels", () => {
  for (const [value, expected] of addressRows) {
    test(`from ${JSON.stringify(value)} -> ${expected}`, () => {
      assertParity({ ...base, from: value }, expected);
    });
    test(`to[0] ${JSON.stringify(value)} -> ${expected}`, () => {
      assertParity({ ...base, to: [value] }, expected);
    });
  }
  for (const [value, expected] of clientNameRows) {
    test(`smtp.clientName ${JSON.stringify(value)} -> ${expected}`, () => {
      assertParity({ ...base, smtp: { ...base.smtp, clientName: value } }, expected);
    });
  }
});

const PADDED = "Ops < ops@example.test >";
const REV_1 = `sha256-${"1".repeat(64)}`;
const D =
  '{"from":"Ops < ops@example.test >","id":"mail","smtp":{"host":"smtp.test","port":587},"to":["ops@example.test"],"type":"email"}';

describe("M3: a padded address stored by a patched api", () => {
  const dir = mkdtempSync(join(tmpdir(), "notify-parity-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("the channels answer applies the record", () => {
    const answer = checkChannelsAnswer({
      revision: REV_1,
      channels: [
        {
          id: "mail",
          type: "email",
          smtp: { host: "smtp.test", port: 587 },
          from: PADDED,
          to: ["ops@example.test"],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    assert.equal(answer.kind, "applied");
    if (answer.kind !== "applied") return;
    assert.deepEqual(answer.rejected, []);
    assert.equal(answer.records.length, 1);
    const [record] = answer.records;
    assert.equal(record?.type, "email");
    if (record?.type !== "email") return;
    assert.equal(record.from, PADDED);
  });

  test("the ledger stores the row and reopens with it", () => {
    const file = join(dir, "state");
    const row = { id: "mail", definition: D, revision: REV_1, appliedAt: 1 };
    const first = new Ledger(file);
    try {
      first.replaceRemoteChannels([row]);
    } finally {
      first.close();
    }
    const second = new Ledger(file);
    try {
      assert.deepEqual(second.remoteChannels(), [row]);
    } finally {
      second.close();
    }
  });
});
