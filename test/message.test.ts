import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmailSender } from "../src/channels/email.ts";
import { createFileSender } from "../src/channels/file.ts";
import type { MailMessage } from "../src/channels/mailer.ts";
import { cleanText, messageParts } from "../src/channels/message.ts";
import { slackText } from "../src/channels/slack.ts";
import { teamsCard } from "../src/channels/teams.ts";
import type { IncidentNotification } from "../src/types.ts";
import { budgetNote, expiryNote } from "./support.ts";

const opened = Date.UTC(2026, 0, 1, 12, 0, 0);

function note(over: Partial<IncidentNotification> = {}): IncidentNotification {
  return {
    key: "1:opened",
    event: "opened",
    incidentId: 1,
    checkId: "example",
    checkName: "Example site",
    reason: "HTTP 503",
    time: new Date(opened).toISOString(),
    timeMs: opened,
    openedMs: opened,
    ...over,
  };
}

test("cleanText removes control characters and cuts to 300 characters", () => {
  assert.equal(cleanText("a\r\nb\u0000c\u0007"), "a  b c");
  const cut = cleanText("x".repeat(500));
  assert.equal(cut.length, 300);
  assert.ok(cut.endsWith("…"));
});

test("slack text for each state, with status link and age", () => {
  assert.equal(
    slackText(messageParts(note(), { statusUrl: "https://status.example.com" })),
    "*DOWN*: Example site\nReason: HTTP 503\nTime: 2026-01-01T12:00:00.000Z\nStatus: https://status.example.com",
  );
  const reminder = note({ event: "reminder", timeMs: opened + 65 * 60000 });
  assert.match(slackText(messageParts(reminder, {})), /^\*STILL DOWN\*: .*\nOpen for: 1h 5m$/s);
  assert.match(slackText(messageParts(note({ event: "resolved" }), {})), /^\*RESOLVED\*/);
});

test("slack escapes markup and blocks mentions", () => {
  const text = slackText(messageParts(note({ reason: "<!channel> a & <@U1>" }), {}));
  assert.ok(text.includes("&lt;!channel&gt; a &amp; &lt;@U1&gt;"));
  assert.ok(!text.includes("<!channel>"));
});

test("hideReason leaves the reason out and the status link is absent when unset", () => {
  const text = slackText(messageParts(note(), { hideReason: true }));
  assert.ok(!text.includes("Reason"));
  assert.ok(!text.includes("Status"));
});

test("teams card is one message with one adaptive card and escaped markdown", () => {
  const card = teamsCard(messageParts(note({ reason: "[x](http://evil) *b*" }), {}));
  assert.equal(card.type, "message");
  const attachments = card.attachments as { contentType: string; content: unknown }[];
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0]?.contentType, "application/vnd.microsoft.card.adaptive");
  const json = JSON.stringify(card);
  assert.ok(json.includes("\\\\[x\\\\]\\\\(http"), json);
  assert.ok(!json.includes("actions"));
  const linked = JSON.stringify(
    teamsCard(messageParts(note(), { statusUrl: "https://s.example" })),
  );
  assert.ok(linked.includes("Action.OpenUrl"));
});

const LINK = { statusUrl: "https://status.example.com" };

test("budget display values are rounded down, null availability reads no data", () => {
  const cases: [number, number | null, string, string][] = [
    [24.96, 99.95, "24.9", "99.950%"],
    [-3.25, 99.8816, "-3.3", "99.881%"],
    [18.4, null, "18.4", "no data"],
  ];
  for (const [remaining, availability, r, a] of cases) {
    const n = budgetNote({
      budget: { remaining, threshold: 25, target: 99.9, availability, windowDays: 30 },
    });
    const text = slackText(messageParts(n, {}));
    assert.ok(text.includes(`Error budget left: ${r}% (alert below 25%)`), text);
    assert.ok(text.includes(`Availability: ${a} (target 99.9%, 30 days)`), text);
  }
});

test("slack text for the three warnings, with the status link and hideReason ignored", () => {
  assert.equal(
    slackText(messageParts(budgetNote(), { ...LINK, hideReason: true })),
    [
      "*BUDGET LOW*: API health",
      "Error budget left: 18.4% (alert below 25%)",
      "Availability: 99.881% (target 99.9%, 30 days)",
      "Time: 2026-01-01T12:00:00.000Z",
      "Status: https://status.example.com",
    ].join("\n"),
  );
  assert.equal(
    slackText(messageParts(expiryNote(), {})),
    [
      "*TLS EXPIRES SOON*: Site TLS",
      "Expires in: 13 days",
      "Kind: TLS certificate",
      "Time: 2026-01-01T12:00:05.000Z",
    ].join("\n"),
  );
  const days: [number, string][] = [
    [1, "Expires in: 1 day"],
    [0, "Expires in: less than 1 day"],
  ];
  for (const [daysLeft, line] of days) {
    const n = expiryNote({
      event: "domain-expiry",
      expiry: { daysLeft, milestone: 3, observedMs: 0 },
    });
    const text = slackText(messageParts(n, {}));
    assert.ok(text.startsWith("*DOMAIN EXPIRES SOON*: Site TLS\n"), text);
    assert.ok(text.includes(`${line}\nKind: domain registration`), text);
  }
});

test("hostile warning names cannot inject slack mentions or teams markup", () => {
  const subject = { kind: "check" as const, id: "a", name: "<!channel> [x](http://evil)\r\n*b*" };
  const slack = slackText(messageParts(budgetNote({ subject }), {}));
  assert.ok(slack.startsWith("*BUDGET LOW*: &lt;!channel&gt; [x](http://evil)  *b*\n"), slack);
  const card = teamsCard(messageParts(expiryNote({ subject }), LINK));
  const [attachment] = card.attachments as { content: { body: { text?: string }[] } }[];
  assert.equal(
    attachment?.content.body[0]?.text,
    String.raw`**TLS EXPIRES SOON**: \<\!channel\> \[x\]\(http://evil\)  \*b\*`,
  );
});

test("a 10000-character warning name with control characters and markup is cleaned and cut", () => {
  const name = `<b>\u0007${"y".repeat(10000)}`;
  const slack = slackText(
    messageParts(budgetNote({ subject: { kind: "check", id: "a", name } }), {}),
  );
  const first = slack.split("\n")[0] ?? "";
  assert.equal(first, `*BUDGET LOW*: &lt;b&gt; ${"y".repeat(295)}…`);
});

test("teams card for a warning lists the warning facts and the status action", () => {
  const card = teamsCard(messageParts(budgetNote(), LINK));
  const json = JSON.stringify(card);
  assert.ok(json.includes('"text":"**BUDGET LOW**: API health"'), json);
  assert.ok(
    json.includes(
      '"facts":[{"title":"Error budget left","value":"18.4% (alert below 25%)"},{"title":"Availability","value":"99.881% (target 99.9%, 30 days)"},{"title":"Time","value":"2026-01-01T12:00:00.000Z"}]',
    ),
    json,
  );
  assert.ok(json.includes('"url":"https://status.example.com"'), json);
});

test("email for a warning: subject with prefix, body lines and a Message-ID from the key", async () => {
  const sent: MailMessage[] = [];
  const send = createEmailSender(
    {
      id: "m",
      type: "email",
      smtp: { host: "127.0.0.1", port: 2525, tls: "none" },
      from: "pulse@example.com",
      to: ["ops@example.com"],
      subjectPrefix: "[pulse]",
      hideReason: true,
      ...LINK,
    },
    {
      sendMail: async (_smtp, message) => {
        sent.push(message);
        return { accepted: [...message.envelopeTo], refused: [] };
      },
      now: () => 0,
    },
  );
  await send(budgetNote({ subject: { kind: "component", id: "web", name: "Web" } }));
  await send(
    expiryNote({ event: "domain-expiry", expiry: { daysLeft: 1, milestone: 3, observedMs: 0 } }),
  );
  assert.equal(sent[0]?.subject, "[pulse] BUDGET LOW: Web");
  assert.equal(
    sent[0]?.text,
    [
      "BUDGET LOW: Web",
      "",
      "Component: Web",
      "Error budget left: 18.4% (alert below 25%)",
      "Availability: 99.881% (target 99.9%, 30 days)",
      "Time: 2026-01-01T12:00:00.000Z",
      "Status: https://status.example.com",
      "",
    ].join("\n"),
  );
  assert.equal(sent[1]?.subject, "[pulse] DOMAIN EXPIRES SOON: Site TLS");
  assert.ok(
    sent[1]?.text.includes("Check: Site TLS\nExpires in: 1 day\nKind: domain registration\n"),
  );
  // SHA-256 of the budget key, first 32 hex characters, computed outside the code under test.
  assert.equal(sent[0]?.messageId, "<9473df0fc0d2774257f67e1b8cb3aabc@example.com>");
});

test("the file sender writes the raw warning JSON with unrounded values", async () => {
  const dir = mkdtempSync(join(tmpdir(), "notify-warn-file-"));
  try {
    const path = join(dir, "out.jsonl");
    const n = budgetNote({
      budget: {
        remaining: 24.96,
        threshold: 25,
        target: 99.9,
        availability: 99.8816,
        windowDays: 30,
      },
    });
    await createFileSender({ id: "f", type: "file", path })(n);
    await createFileSender({ id: "f", type: "file", path })(expiryNote());
    const lines = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as unknown);
    assert.deepEqual(lines, [
      {
        key: "budget:check:1767268800000:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        event: "budget-low",
        time: "2026-01-01T12:00:00.000Z",
        timeMs: 1767268800000,
        subject: { kind: "check", id: "api-health", name: "API health" },
        budget: {
          remaining: 24.96,
          threshold: 25,
          target: 99.9,
          availability: 99.8816,
          windowDays: 30,
        },
      },
      {
        key: "expiry:1767268800000:14:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        event: "tls-expiry",
        time: "2026-01-01T12:00:05.000Z",
        timeMs: 1767268805000,
        subject: { kind: "check", id: "site-tls", name: "Site TLS" },
        expiry: { daysLeft: 13, milestone: 14, observedMs: 1767268800000 },
      },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
