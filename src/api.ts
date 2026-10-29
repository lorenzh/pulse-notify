import {
  type Check,
  checkWireVersion,
  type Incident,
  validateCheck,
  validateIncident,
  WIRE_VERSION_HEADER,
} from "@lorenzh/pulse-contract";
import { fetchWithTimeout } from "./timeout.ts";
import type { Schedule } from "./types.ts";

export interface ApiOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  schedule?: Schedule;
  /** Called when a response has no wire version header. */
  onVersionAbsent?: () => void;
  /** Called with the contract error for each check that is skipped. */
  onInvalidCheck?: (error: string) => void;
}

export interface RejectedIncident {
  id: unknown;
  reason: string;
}

export interface IncidentsResult {
  incidents: Incident[];
  rejected: RejectedIncident[];
}

async function getArray(opts: ApiOptions, path: string): Promise<unknown[]> {
  const url = new URL(path, opts.baseUrl.endsWith("/") ? opts.baseUrl : `${opts.baseUrl}/`);
  return fetchWithTimeout(
    opts.fetch ?? fetch,
    url.toString().replace(/\/$/, ""),
    { headers: { accept: "application/json" } },
    opts.timeoutMs ?? 5000,
    async (res) => {
      const version = checkWireVersion(res.headers.get(WIRE_VERSION_HEADER));
      if (version.status === "mismatch") {
        await res.body?.cancel();
        throw new Error(`GET ${path} wire version mismatch: ${version.error}`);
      }
      if (version.status === "absent") opts.onVersionAbsent?.();
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`GET ${path} returned ${res.status}`);
      }
      const body: unknown = await res.json();
      if (!Array.isArray(body)) throw new Error(`GET ${path} did not return an array`);
      return body;
    },
    opts.schedule,
  );
}

/** The range of `Date` in milliseconds; outside it `toISOString()` throws. */
const MAX_DATE_MS = 8.64e15;

function isDateMs(value: number): boolean {
  return Math.abs(value) <= MAX_DATE_MS;
}

/** Returns the incident, or the reason why the raw value is not one. */
function checkIncident(raw: unknown, path: string): Incident | string {
  const validated = validateIncident(raw, path);
  if (!validated.ok) return validated.error;
  const { openedAt, resolvedAt } = validated.value;
  if (!isDateMs(openedAt)) return "openedAt is not a valid date";
  if (resolvedAt != null && !isDateMs(resolvedAt)) return "resolvedAt is not a valid date";
  return validated.value;
}

export async function fetchIncidents(opts: ApiOptions): Promise<IncidentsResult> {
  const result: IncidentsResult = { incidents: [], rejected: [] };
  const items = await getArray(opts, "incidents");
  for (const [i, raw] of items.entries()) {
    const checked = checkIncident(raw, `incidents[${i}]`);
    if (typeof checked === "string") {
      const id = typeof raw === "object" && raw !== null ? (raw as { id?: unknown }).id : undefined;
      result.rejected.push({ id, reason: checked });
    } else {
      result.incidents.push(checked);
    }
  }
  return result;
}

/** Checks only supply display names; entries that are not valid checks are dropped. */
export async function fetchChecks(opts: ApiOptions): Promise<Check[]> {
  const checks: Check[] = [];
  const items = await getArray(opts, "checks");
  for (const [i, raw] of items.entries()) {
    const validated = validateCheck(raw, `checks[${i}]`);
    if (validated.ok) {
      checks.push(validated.value);
    } else {
      opts.onInvalidCheck?.(validated.error);
    }
  }
  return checks;
}
