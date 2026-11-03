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

/**
 * Whether the channel wants a manual incident. Check filters do not apply; component filters do.
 * An incident without components matches only a channel without a `components` include list.
 */
export function isManualRouted(
  channel: Pick<ChannelConfig, "components" | "excludeComponents">,
  componentIds: string[],
): boolean {
  if (channel.excludeComponents?.some((id) => componentIds.includes(id))) return false;
  const include = channel.components;
  if (include === undefined || include.length === 0) return true;
  return componentIds.some((id) => include.includes(id));
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

type CheckFilters = Pick<ChannelConfig, "checks" | "excludeChecks">;
type ComponentFilters = Pick<ChannelConfig, "components" | "excludeComponents">;

/** By code unit, so the order does not depend on the locale. */
function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Sorted, without duplicates; an absent list is the same as an empty one. */
function normalized(list: string[] | undefined): string[] {
  return [...new Set(list ?? [])].sort(compareCodeUnits);
}

/** The check filters of a channel as stable text: equal filters give equal text. */
export function checkRouting(channel: CheckFilters): string {
  return JSON.stringify({
    checks: normalized(channel.checks),
    excludeChecks: normalized(channel.excludeChecks),
  });
}

/** The component filters of a channel as stable text: equal filters give equal text. */
export function componentRouting(channel: ComponentFilters): string {
  return JSON.stringify({
    components: normalized(channel.components),
    excludeComponents: normalized(channel.excludeComponents),
  });
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function parseRecord(text: string): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // A stored fingerprint that is not JSON has no filters; the caller treats it as absent.
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** The check filters stored by `checkRouting`, or `undefined` when the text has another shape. */
export function parseCheckRouting(text: string): CheckFilters | undefined {
  const value = parseRecord(text);
  if (!value || !isStringList(value.checks) || !isStringList(value.excludeChecks)) return undefined;
  return { checks: value.checks, excludeChecks: value.excludeChecks };
}

/** The component filters stored by `componentRouting`, or `undefined` for another shape. */
export function parseComponentRouting(text: string): ComponentFilters | undefined {
  const value = parseRecord(text);
  if (!value || !isStringList(value.components) || !isStringList(value.excludeComponents)) {
    return undefined;
  }
  return { components: value.components, excludeComponents: value.excludeComponents };
}
