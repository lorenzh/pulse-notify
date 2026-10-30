import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanText, messageParts } from "../src/channels/message.ts";
import { slackText } from "../src/channels/slack.ts";
import { teamsCard } from "../src/channels/teams.ts";
import type { Notification } from "../src/types.ts";

const opened = Date.UTC(2026, 0, 1, 12, 0, 0);

function note(over: Partial<Notification> = {}): Notification {
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
