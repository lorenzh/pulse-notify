import {
  type Check,
  type CheckWithState,
  type ComponentWithState,
  DEFAULT_MAX_BODY_BYTES,
  type FetchJsonError,
  type FetchJsonOptions,
  fetchJson,
  type Incident,
  isPublicManualIncident,
  type ManualIncident,
  publicManualIncident,
  type Validation,
  validateCheck,
  validateCheckWithState,
  validateComponentWithState,
  validateIncident,
  validateManualIncident,
  WIRE_VERSION,
} from "@lorenzh/pulse-contract";
import { redactInText } from "./redact.ts";
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
  /** Called with the array index of each check that is skipped. */
  onInvalidCheck?: (index: number) => void;
  /** Called with the array index of each component that is skipped. */
  onInvalidComponent?: (index: number) => void;
}

/** A fixed category: no text from the api response reaches a log line. */
export type SkipReason =
  | "invalid"
  | "openedAt is not a valid date"
  | "resolvedAt is not a valid date"
  | "time is not a valid date";

export interface RejectedIncident {
  index: number;
  /** The raw id, only when it is a safe integer. */
  id: number | undefined;
  reason: SkipReason;
}

/** Reads the raw id without converting it: only a safe integer is kept. */
function safeId(raw: unknown): number | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const id: unknown = Object.getOwnPropertyDescriptor(raw, "id")?.value;
  return typeof id === "number" && Number.isSafeInteger(id) ? id : undefined;
}

export interface IncidentsResult {
  incidents: Incident[];
  rejected: RejectedIncident[];
}

export const DEFAULT_API_MAX_BYTES = DEFAULT_MAX_BODY_BYTES;

/**
 * A failed api read. `kind` is the `FetchJsonError` kind; for `http` it carries the status
 * (`http:500`), so callers can tell failures apart without reading the message.
 */
export class ApiReadError extends Error {
  readonly kind: string;

  constructor(message: string, kind: string) {
    super(message);
    this.name = "ApiReadError";
    this.kind = kind;
  }
}

function failureKind(error: FetchJsonError): string {
  return error.kind === "http" ? `http:${error.status}` : error.kind;
}

/** An error without the original cause and with the API url redacted in its text. */
function redactedError(err: unknown, baseUrl: string, kind: string): ApiReadError {
  const message = err instanceof Error ? err.message : String(err);
  const error = new ApiReadError(redactInText(message, baseUrl), kind);
  let current: unknown = err;
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") Object.assign(error, { code });
    current = current.cause;
  }
  return error;
}

/** The error for each failure of the shared client, with the text callers know. */
function apiError(error: FetchJsonError, path: string): unknown {
  switch (error.kind) {
    case "timeout":
      return new Error(`timeout after ${error.timeoutMs}ms`);
    case "aborted":
      return new Error(`GET ${path} was aborted`);
    case "network":
      return error.cause;
    case "http":
      return new Error(`GET ${path} returned ${error.status}`);
    case "too-large":
      return new Error(`GET ${path} response is larger than ${error.maxBytes} bytes`);
    case "invalid-json":
      return new Error(`GET ${path} returned invalid JSON`);
    case "validation":
      return new Error(`GET ${path} did not return an array`);
    case "wire-mismatch":
      return new Error(`GET ${path} wire version mismatch (expected ${WIRE_VERSION})`);
    default: {
      const unreachable: never = error;
      return unreachable;
    }
  }
}

/** Accepts any array; the caller checks each item so one bad item can be skipped. */
function validateArray(path: string): (raw: unknown) => Validation<unknown[]> {
  return (raw) =>
    Array.isArray(raw)
      ? { ok: true, value: raw }
      : { ok: false, error: `GET ${path} did not return an array` };
}

async function getArray(
  opts: ApiOptions,
  path: string,
  isAbsentTolerated: true,
): Promise<unknown[] | undefined>;
async function getArray(opts: ApiOptions, path: string): Promise<unknown[]>;
async function getArray(
  opts: ApiOptions,
  path: string,
  isAbsentTolerated = false,
): Promise<unknown[] | undefined> {
  const base = opts.fetch ?? fetch;
  // No redirect is followed, also not same-origin: PULSE_API_URL must be the final endpoint.
  const noRedirect: FetchJsonOptions<unknown[]>["fetch"] = (input, init) =>
    base(input, { ...init, redirect: "manual" });
  const url = new URL(path, opts.baseUrl.endsWith("/") ? opts.baseUrl : `${opts.baseUrl}/`);
  const options: FetchJsonOptions<unknown[]> = {
    fetch: noRedirect,
    validate: validateArray(path),
    timeoutMs: opts.timeoutMs ?? 5000,
    maxBytes: opts.maxBytes ?? DEFAULT_API_MAX_BYTES,
    headers: { accept: "application/json" },
  };
  if (opts.onVersionAbsent) options.onWireAbsent = opts.onVersionAbsent;
  if (opts.schedule) options.schedule = opts.schedule;
  const result = await fetchJson(url.toString().replace(/\/$/, ""), options);
  if (result.ok) return result.value;
  if (isAbsentTolerated && result.error.kind === "http" && result.error.status === 404) {
    return undefined;
  }
  throw redactedError(apiError(result.error, path), opts.baseUrl, failureKind(result.error));
}

/** The range of `Date` in milliseconds; outside it `toISOString()` throws. */
const MAX_DATE_MS = 8.64e15;

function isDateMs(value: number): boolean {
  return Math.abs(value) <= MAX_DATE_MS;
}

/** Returns the incident, or the reason why the raw value is not one. */
function checkIncident(
  raw: unknown,
  path: string,
): { incident: Incident } | { reason: SkipReason } {
  const validated = validateIncident(raw, path);
  if (!validated.ok) return { reason: "invalid" };
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
      result.rejected.push({ index: i, id: safeId(raw), reason: checked.reason });
    } else {
      result.incidents.push(checked.incident);
    }
  }
  return result;
}

export interface ChecksResult {
  /** Every valid `Check`: the display names of incidents. */
  checks: Check[];
  /** The checks that are also a valid `CheckWithState`; empty unless `withState` was set. */
  states: CheckWithState[];
  /** The id of every listed item, valid or not: an item that is still listed keeps its alert state. */
  listedIds: Set<string>;
}

/** The `id` of a raw feed item when it is an own string data property, else `undefined`. */
function listedId(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  // A descriptor read never runs a getter of untrusted input.
  const value: unknown = Object.getOwnPropertyDescriptor(raw, "id")?.value;
  return typeof value === "string" ? value : undefined;
}

/**
 * Reads `/checks`. Items that are not valid checks are dropped. With `withState`, a valid check
 * is also checked as a `CheckWithState` for alerts; a failure there keeps its name.
 */
export async function fetchChecksWithState(
  opts: ApiOptions,
  withState: boolean,
): Promise<ChecksResult> {
  const result: ChecksResult = { checks: [], states: [], listedIds: new Set() };
  const items = await getArray(opts, "checks");
  for (const [i, raw] of items.entries()) {
    const path = `checks[${i}]`;
    const id = listedId(raw);
    if (id !== undefined) result.listedIds.add(id);
    // The with-state validator also checks the base fields, so a valid item is validated once.
    const stated = withState ? validateCheckWithState(raw, path) : undefined;
    if (stated?.ok === true) {
      result.checks.push(stated.value);
      result.states.push(stated.value);
      continue;
    }
    const validated = validateCheck(raw, path);
    if (validated.ok) result.checks.push(validated.value);
    // Without state a valid check is fine; with state it failed the second validator.
    if (!validated.ok || withState) opts.onInvalidCheck?.(i);
  }
  return result;
}

/** Checks only supply display names; entries that are not valid checks are dropped. */
export async function fetchChecks(opts: ApiOptions): Promise<Check[]> {
  return (await fetchChecksWithState(opts, false)).checks;
}

export interface ComponentsResult {
  /** The valid components. */
  components: ComponentWithState[];
  /** The id of every listed item, valid or not. */
  listedIds: Set<string>;
}

/** Reads `/components`; `undefined` on a 404 (an older api). Invalid items are skipped. */
export async function fetchComponents(opts: ApiOptions): Promise<ComponentsResult | undefined> {
  const items = await getArray(opts, "components", true);
  if (items === undefined) return undefined;
  const components: ComponentWithState[] = [];
  const listedIds = new Set<string>();
  for (const [i, raw] of items.entries()) {
    const id = listedId(raw);
    if (id !== undefined) listedIds.add(id);
    const validated = validateComponentWithState(raw, `components[${i}]`);
    if (validated.ok) components.push(validated.value);
    else opts.onInvalidComponent?.(i);
  }
  return { components, listedIds };
}

export interface ManualIncidentsResult {
  incidents: ManualIncident[];
  rejected: RejectedIncident[];
  /** True when the api answered 404: an older api without manual incidents. */
  isAbsent: boolean;
}

/** Reads `/manual-incidents`. A 404 means "none" (`isAbsent`); other failures throw. */
export async function fetchManualIncidents(opts: ApiOptions): Promise<ManualIncidentsResult> {
  const result: ManualIncidentsResult = { incidents: [], rejected: [], isAbsent: false };
  const items = await getArray(opts, "manual-incidents", true);
  if (items === undefined) return { ...result, isAbsent: true };
  for (const [i, raw] of items.entries()) {
    // A draft or internal incident is skipped before validation: never rejected, logged or counted.
    if (!isPublicManualIncident(raw)) continue;
    const path = `manual-incidents[${i}]`;
    const validated = validateManualIncident(raw, path);
    const isValid =
      validated.ok && isDateMs(validated.value.createdAt) && updatesHaveDates(validated.value);
    if (validated.ok && isValid) {
      result.incidents.push(publicManualIncident(validated.value));
    } else {
      result.rejected.push({
        index: i,
        id: safeId(raw),
        reason: validated.ok ? "time is not a valid date" : "invalid",
      });
    }
  }
  return result;
}

function updatesHaveDates(incident: ManualIncident): boolean {
  return (
    incident.updates.every((u) => isDateMs(u.at)) &&
    (incident.resolvedAt === null || isDateMs(incident.resolvedAt))
  );
}
