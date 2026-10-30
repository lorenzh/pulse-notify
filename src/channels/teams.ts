import type { Sender, TeamsChannelConfig } from "../types.ts";
import { type HttpDeps, postJson } from "./http-post.ts";
import { type MessageParts, messageParts } from "./message.ts";

/** Backslash-escapes the characters that Adaptive Card text treats as markdown. */
function escapeTeams(text: string): string {
  return text.replace(/[\\`*_[\]()<>~#|&!]/g, "\\$&");
}

/** One message with one Adaptive Card attachment, the shape the Workflows URL accepts. */
export function teamsCard(parts: MessageParts): Record<string, unknown> {
  const facts: { title: string; value: string }[] = [];
  const m = parts.manual;
  if (m) {
    facts.push({ title: "Impact", value: m.impact }, { title: "Status", value: m.status });
    facts.push({ title: "Message", value: escapeTeams(m.message) });
    if (m.components !== "") facts.push({ title: "Components", value: escapeTeams(m.components) });
  }
  if (parts.reason !== undefined) facts.push({ title: "Reason", value: escapeTeams(parts.reason) });
  facts.push({ title: "Time", value: parts.time });
  if (parts.openFor !== undefined) facts.push({ title: "Open for", value: parts.openFor });
  const content: Record<string, unknown> = {
    // The Adaptive Card schema identifier is an http URL by definition.
    // eslint-disable-next-line sonarjs/no-clear-text-protocols
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: `**${parts.state}**: ${escapeTeams(parts.name)}`,
        wrap: true,
        size: "Medium",
      },
      { type: "FactSet", facts },
    ],
  };
  if (parts.link !== undefined) {
    content.actions = [{ type: "Action.OpenUrl", title: "Status page", url: parts.link }];
  }
  return {
    type: "message",
    attachments: [
      { contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null, content },
    ],
  };
}

export function createTeamsSender(channel: TeamsChannelConfig, deps: HttpDeps = {}): Sender {
  return async (notification, signal) => {
    const card = teamsCard(messageParts(notification, channel));
    await postJson("teams", channel.url, {}, JSON.stringify(card), deps, signal);
  };
}
