import type { Check, Incident } from "@lorenzh/pulse-contract";
import { fetchWithTimeout } from "./timeout.ts";
import type { Schedule } from "./types.ts";

export interface ApiOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  schedule?: Schedule;
}

async function getArray<T>(opts: ApiOptions, path: string): Promise<T[]> {
  const url = new URL(path, opts.baseUrl.endsWith("/") ? opts.baseUrl : `${opts.baseUrl}/`);
  const res = await fetchWithTimeout(
    opts.fetch ?? fetch,
    url.toString().replace(/\/$/, ""),
    { headers: { accept: "application/json" } },
    opts.timeoutMs ?? 5000,
    opts.schedule,
  );
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`GET ${path} returned ${res.status}`);
  }
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new Error(`GET ${path} did not return an array`);
  return body as T[];
}

export function fetchIncidents(opts: ApiOptions): Promise<Incident[]> {
  return getArray<Incident>(opts, "incidents");
}

export function fetchChecks(opts: ApiOptions): Promise<Check[]> {
  return getArray<Check>(opts, "checks");
}
