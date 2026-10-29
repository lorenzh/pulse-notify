import type { Sender, SlackChannelConfig } from "../types.ts";
import { type HttpDeps, postJson } from "./http-post.ts";
import { type MessageParts, messageParts } from "./message.ts";

/** Slack treats `& < >` as markup; escaping `<` also blocks `<!channel>` and user mentions. */
function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function slackText(parts: MessageParts): string {
  const lines = [`*${parts.state}*: ${escapeSlack(parts.name)}`];
  if (parts.reason !== undefined) lines.push(`Reason: ${escapeSlack(parts.reason)}`);
  lines.push(`Time: ${parts.time}`);
  if (parts.openFor !== undefined) lines.push(`Open for: ${parts.openFor}`);
  if (parts.link !== undefined) lines.push(`Status: ${escapeSlack(parts.link)}`);
  return lines.join("\n");
}

export function createSlackSender(channel: SlackChannelConfig, deps: HttpDeps = {}): Sender {
  return async (notification, signal) => {
    const text = slackText(messageParts(notification, channel));
    await postJson("slack", channel.url, {}, JSON.stringify({ text }), deps, signal);
  };
}
