import type { ChannelConfig } from "../types.ts";

function escapeRegExp(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/** An entry without `*` matches exactly; `*` matches any characters. */
function isEntryMatch(entry: string, checkId: string): boolean {
  if (!entry.includes("*")) return entry === checkId;
  const pattern = entry.split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${pattern}$`, "s").test(checkId);
}

function isListed(list: string[] | undefined, checkId: string): boolean {
  return list?.some((entry) => isEntryMatch(entry, checkId)) ?? false;
}

/** Whether the channel wants notifications about the check: `excludeChecks` wins over `checks`. */
export function isRouted(
  channel: Pick<ChannelConfig, "checks" | "excludeChecks">,
  checkId: string,
): boolean {
  if (isListed(channel.excludeChecks, checkId)) return false;
  const include = channel.checks;
  return include === undefined || include.length === 0 || isListed(include, checkId);
}
