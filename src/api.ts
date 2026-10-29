import type { Check, Incident } from "@lorenzh/pulse-contract";
import { fetchWithTimeout } from "./timeout.ts";
import type { Schedule } from "./types.ts";

export interface ApiOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  schedule?: Schedule;
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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Returns the incident, or the reason why the raw value is not one. */
function checkIncident(raw: unknown): Incident | string {
  if (typeof raw !== "object" || raw === null) return "not an object";
  const r = raw as Record<string, unknown>;
  if (!isFiniteNumber(r.id)) return "id is not a number";
  if (typeof r.checkId !== "string") return "checkId is not a string";
  if (!isFiniteNumber(r.openedAt)) return "openedAt is not a finite number";
  if (r.resolvedAt != null && !isFiniteNumber(r.resolvedAt)) {
    return "resolvedAt is not a finite number";
  }
  // The checks above are the trust boundary for the contract type.
  return raw as Incident;
}

export async function fetchIncidents(opts: ApiOptions): Promise<IncidentsResult> {
  const result: IncidentsResult = { incidents: [], rejected: [] };
  for (const raw of await getArray(opts, "incidents")) {
    const checked = checkIncident(raw);
    if (typeof checked === "string") {
      const id = typeof raw === "object" && raw !== null ? (raw as { id?: unknown }).id : undefined;
      result.rejected.push({ id, reason: checked });
    } else {
      result.incidents.push(checked);
    }
  }
  return result;
}

/** Checks only supply display names; entries without a string id and name are dropped. */
export async function fetchChecks(opts: ApiOptions): Promise<Check[]> {
  const raw = await getArray(opts, "checks");
  return raw.filter((c): c is Check => {
    if (typeof c !== "object" || c === null) return false;
    const r = c as Record<string, unknown>;
    return typeof r.id === "string" && typeof r.name === "string";
  });
}
