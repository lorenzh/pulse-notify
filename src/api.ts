import {
  type Check,
  checkWireVersion,
  type Incident,
  validateCheck,
  validateIncident,
  WIRE_VERSION_HEADER,
} from "@lorenzh/pulse-contract";
import { redactInText } from "./redact.ts";
import { fetchWithTimeout } from "./timeout.ts";
import type { Schedule } from "./types.ts";

export interface ApiOptions {
  baseUrl: string;
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  /** Largest response body in bytes; defaults to `DEFAULT_API_MAX_BYTES`. */
  maxBytes?: number | undefined;
  schedule?: Schedule | undefined;
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

export const DEFAULT_API_MAX_BYTES = 5 * 1024 * 1024;

/** Reads the JSON body and stops with an error once it passes `maxBytes`. */
async function readJson(res: Response, maxBytes: number, path: string): Promise<unknown> {
  const tooLarge = (): Error => new Error(`GET ${path} response is larger than ${maxBytes} bytes`);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel();
    throw tooLarge();
  }
  // A response without a stream has no bytes to count: let it parse itself.
  if (!res.body) return res.json();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  const reader = res.body.getReader();
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      total += chunk.value.byteLength;
      if (total > maxBytes) throw tooLarge();
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch (err) {
    await reader.cancel().catch(() => {
      // The stream is already broken; the original error is what matters.
    });
    throw err;
  }
  return JSON.parse(text + decoder.decode());
}

/** An error without the original cause and with the API url redacted in its text. */
function redactedError(err: unknown, baseUrl: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  const error = new Error(redactInText(message, baseUrl));
  let current: unknown = err;
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") Object.assign(error, { code });
    current = current.cause;
  }
  return error;
}

async function getArray(opts: ApiOptions, path: string): Promise<unknown[]> {
  const maxBytes = opts.maxBytes ?? DEFAULT_API_MAX_BYTES;
  try {
    const url = new URL(path, opts.baseUrl.endsWith("/") ? opts.baseUrl : `${opts.baseUrl}/`);
    return await fetchWithTimeout(
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
        const body = await readJson(res, maxBytes, path);
        if (!Array.isArray(body)) throw new Error(`GET ${path} did not return an array`);
        return body;
      },
      opts.schedule,
    );
  } catch (err) {
    throw redactedError(err, opts.baseUrl);
  }
}

/** The range of `Date` in milliseconds; outside it `toISOString()` throws. */
const MAX_DATE_MS = 8.64e15;

function isDateMs(value: number): boolean {
  return Math.abs(value) <= MAX_DATE_MS;
}

/** Returns the incident, or the reason why the raw value is not one. */
function checkIncident(raw: unknown, path: string): { incident: Incident } | { reason: string } {
  const validated = validateIncident(raw, path);
  if (!validated.ok) return { reason: validated.error };
  const { openedAt, resolvedAt } = validated.value;
  if (!isDateMs(openedAt)) return { reason: "openedAt is not a valid date" };
  if (resolvedAt != null && !isDateMs(resolvedAt)) {
    return { reason: "resolvedAt is not a valid date" };
  }
  return { incident: validated.value };
}

export async function fetchIncidents(opts: ApiOptions): Promise<IncidentsResult> {
  const result: IncidentsResult = { incidents: [], rejected: [] };
  const items = await getArray(opts, "incidents");
  for (const [i, raw] of items.entries()) {
    const checked = checkIncident(raw, `incidents[${i}]`);
    if ("reason" in checked) {
      const id = typeof raw === "object" && raw !== null ? (raw as { id?: unknown }).id : undefined;
      result.rejected.push({ id, reason: checked.reason });
    } else {
      result.incidents.push(checked.incident);
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
