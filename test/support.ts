import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  Check,
  CheckStateFields,
  CheckWithState,
  ComponentWithState,
  Incident,
  ManualIncident,
  Slo,
} from "@lorenzh/pulse-contract";
import {
  type AtomicWriteFs,
  type AtomicWriteSyncFs,
  type Logger,
  type LogLevel,
  nodeAtomicWriteFs,
  nodeAtomicWriteSyncFs,
} from "@lorenzh/pulse-kit";
import type { AlertKind, AlertState, Ledger } from "../src/ledger.ts";
import type { BudgetNotification, ExpiryNotification } from "../src/types.ts";

export interface LogEntry {
  level: LogLevel;
  msg: string;
  fields: Record<string, unknown>;
}

export interface SpyLogger extends Logger {
  entries: LogEntry[];
  waitFor(predicate: (entry: LogEntry) => boolean): Promise<LogEntry>;
}

export function spyLogger(): SpyLogger {
  const entries: LogEntry[] = [];
  const waiters: { predicate: (e: LogEntry) => boolean; resolve: (e: LogEntry) => void }[] = [];
  const record =
    (level: LogLevel) =>
    (msg: string, fields: Record<string, unknown> = {}): void => {
      const entry = { level, msg, fields };
      entries.push(entry);
      for (const w of [...waiters]) {
        if (w.predicate(entry)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(entry);
        }
      }
    };
  return {
    entries,
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    waitFor(predicate) {
      const found = entries.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve) => waiters.push({ predicate, resolve }));
    },
  };
}

export function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

export function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

export interface FakeApi {
  url: string;
  incidents: Incident[];
  checks: Check[];
  /** `undefined` answers 404, like an older api. */
  manualIncidents: ManualIncident[] | undefined;
  /** `undefined` (the default) answers 404, like an older api. */
  components: ComponentWithState[] | undefined;
  failing: boolean;
  /** Answers 500 on `/manual-incidents` only. */
  failingManual: boolean;
  /** Paths (like `/checks`) that answer with the given status instead of data. */
  failingPaths: Map<string, number>;
  /** Paths requested so far, in order. */
  requested: string[];
  /** Paths that answer with this raw status, headers and body text, before any other rule. */
  raw: Map<string, RawAnswer>;
  /** The `authorization` header of each request, in order, with its path. */
  authorizations: { path: string; authorization: string | undefined }[];
  /** The answer of `GET /service/notify/channels`; `undefined` answers 404. */
  notifyChannels: { etag: string; body: unknown } | undefined;
  /** Bodies of `PUT /service/notify/report`, parsed, in order; each answers 204. */
  reports: unknown[];
  close(): Promise<void>;
}

export interface RawAnswer {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

/** Answers the channels with their ETag, or 304 when the request names it. */
function answerChannels(
  req: IncomingMessage,
  res: ServerResponse,
  channels: { etag: string; body: unknown },
): void {
  res.setHeader("etag", channels.etag);
  if (req.headers["if-none-match"] === channels.etag) {
    res.statusCode = 304;
    res.end();
  } else res.end(JSON.stringify(channels.body));
}

/** Stores the parsed body of a report and answers 204, like the api. */
function recordReport(req: IncomingMessage, res: ServerResponse, reports: unknown[]): void {
  let text = "";
  req.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  req.on("end", () => {
    reports.push(JSON.parse(text));
    res.statusCode = 204;
    res.end();
  });
}

export async function startFakeApi(): Promise<FakeApi> {
  const api: FakeApi = {
    url: "",
    incidents: [],
    checks: [],
    manualIncidents: [],
    components: undefined,
    failing: false,
    failingManual: false,
    failingPaths: new Map(),
    requested: [],
    raw: new Map(),
    authorizations: [],
    notifyChannels: undefined,
    reports: [],
    close: () => close(server),
  };
  const server = createServer((req, res) => {
    api.requested.push(req.url ?? "");
    api.authorizations.push({ path: req.url ?? "", authorization: req.headers.authorization });
    const raw = api.raw.get(req.url ?? "");
    if (raw) {
      res.writeHead(raw.status ?? 200, raw.headers ?? {});
      res.end(raw.body ?? "");
      return;
    }
    if (req.method === "PUT" && req.url === "/service/notify/report") {
      recordReport(req, res, api.reports);
      return;
    }
    const failStatus = api.failingPaths.get(req.url ?? "");
    if (api.failing || (api.failingManual && req.url === "/manual-incidents") || failStatus) {
      res.statusCode = failStatus ?? 500;
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    if (req.url === "/service/notify/channels" && api.notifyChannels) {
      answerChannels(req, res, api.notifyChannels);
    } else if (req.url === "/incidents") res.end(JSON.stringify(api.incidents));
    else if (req.url === "/manual-incidents" && api.manualIncidents) {
      res.end(JSON.stringify(api.manualIncidents));
    } else if (req.url === "/checks") res.end(JSON.stringify(api.checks));
    else if (req.url === "/components" && api.components) {
      res.end(JSON.stringify(api.components));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  api.url = await listen(server);
  return api;
}

export interface ReceivedRequest {
  method: string | undefined;
  /** The request path and query. */
  url?: string | undefined;
  headers: IncomingMessage["headers"];
  body: unknown;
  /** The body bytes as text, for signature checks. */
  raw: string;
  status: number;
}

export interface Receiver {
  url: string;
  up: boolean;
  /** Status returned while up. */
  status: number;
  requests: ReceivedRequest[];
  /** Requests answered 2xx. */
  accepted(): ReceivedRequest[];
  close(): Promise<void>;
}

export async function startReceiver(): Promise<Receiver> {
  const receiver: Receiver = {
    url: "",
    up: true,
    status: 200,
    requests: [],
    accepted: () => receiver.requests.filter((r) => r.status >= 200 && r.status < 300),
    close: () => close(server),
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const status = receiver.up ? receiver.status : 503;
      let body: unknown = null;
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        body = JSON.parse(raw);
      } catch {
        // Non-JSON payloads are recorded with a null body.
        body = null;
      }
      receiver.requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
        raw,
        status,
      });
      res.statusCode = status;
      res.end();
    });
  });
  receiver.url = await listen(server);
  return receiver;
}

export function incident(over: Partial<Incident> & { id: number }): Incident {
  return {
    checkId: "example",
    openedAt: Date.UTC(2026, 0, 1, 12, 0, 0),
    resolvedAt: null,
    reason: "HTTP 503",
    ...over,
  };
}

export function httpCheck(id: string, name: string): Check {
  // eslint-disable-next-line sonarjs/no-clear-text-protocols -- fixture URL is never requested
  return { id, name, url: "http://example.invalid", intervalMs: 1000 };
}

export function heartbeatCheck(id: string, name: string): Check {
  return { id, name, type: "heartbeat", period: 60_000, grace: 5000 };
}

export function tlsCheck(id: string, name: string): Check {
  return {
    id,
    name,
    type: "tls",
    host: "example.invalid",
    port: 443,
    warnDays: 14,
    intervalMs: 60_000,
  };
}

export function tcpCheck(id: string, name: string): Check {
  return { id, name, type: "tcp", host: "db.example.invalid", port: 5432, intervalMs: 60_000 };
}

export function dnsCheck(id: string, name: string): Check {
  return { id, name, type: "dns", dnsName: "example.com", recordType: "A", intervalMs: 60_000 };
}

export function domainCheck(id: string, name: string): Check {
  return { id, name, type: "domain", domain: "example.com", warnDays: 30, intervalMs: 3_600_000 };
}

/** Narrows a received body to a JSON object, failing the test otherwise. */
export function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("expected a JSON object body");
  }
  return body as Record<string, unknown>;
}

export function manualIncident(over: Partial<ManualIncident> & { id: number }): ManualIncident {
  const createdAt = Date.UTC(2026, 0, 1, 12, 0, 0);
  return {
    title: "Search is slow",
    componentIds: ["web"],
    impact: "minor",
    status: "investigating",
    createdAt,
    resolvedAt: null,
    updates: [{ at: createdAt, status: "investigating", message: "We are looking." }],
    ...over,
  };
}

type FetchCall = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Gives a fake the full `typeof fetch` shape, which Bun's types extend with `preconnect`. */
export function fakeFetch(call: FetchCall): typeof fetch {
  return Object.assign(call, { preconnect: () => {} });
}

/** Switches that make the recording fs fail one step with an errno-like error. */
export interface FsFaults {
  isOpenTempFailing?: boolean;
  isTempFsyncFailing?: boolean;
  isDirFsyncFailing?: boolean;
}

/** Steps of an atomic write, as recorded: `fsync:file`, `rename`, `open:dir`, `fsync:dir`. */
export interface RecordingFs {
  steps: string[];
  faults: FsFaults;
  sync: AtomicWriteSyncFs;
  async: AtomicWriteFs;
}

function fsFault(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

/** The kit node fs, wrapped so a test sees the order of the durable steps and can inject faults. */
export function recordingFs(): RecordingFs {
  const steps: string[] = [];
  const faults: FsFaults = {};
  const dirFds = new Set<number>();
  const beforeOpen = (flags: "wx" | "r"): void => {
    if (flags === "wx" && faults.isOpenTempFailing === true) throw fsFault("ENOSPC");
  };
  const afterOpen = (fd: number, flags: "wx" | "r"): void => {
    if (flags === "r") {
      dirFds.add(fd);
      steps.push("open:dir");
    }
  };
  const beforeFsync = (fd: number): void => {
    const isDir = dirFds.has(fd);
    steps.push(isDir ? "fsync:dir" : "fsync:file");
    if (isDir && faults.isDirFsyncFailing === true) throw fsFault("EIO");
    if (!isDir && faults.isTempFsyncFailing === true) throw fsFault("EIO");
  };
  const sync: AtomicWriteSyncFs = {
    ...nodeAtomicWriteSyncFs,
    open: (path, flags, mode) => {
      beforeOpen(flags);
      const fd = nodeAtomicWriteSyncFs.open(path, flags, mode);
      afterOpen(fd, flags);
      return fd;
    },
    fsync: (fd) => {
      beforeFsync(fd);
      nodeAtomicWriteSyncFs.fsync(fd);
    },
    close: (fd) => {
      dirFds.delete(fd);
      nodeAtomicWriteSyncFs.close(fd);
    },
    rename: (from, to) => {
      steps.push("rename");
      nodeAtomicWriteSyncFs.rename(from, to);
    },
  };
  const async: AtomicWriteFs = {
    ...nodeAtomicWriteFs,
    open: async (path, flags, mode) => {
      beforeOpen(flags);
      const fd = await nodeAtomicWriteFs.open(path, flags, mode);
      afterOpen(fd, flags);
      return fd;
    },
    fsync: async (fd) => {
      beforeFsync(fd);
      await nodeAtomicWriteFs.fsync(fd);
    },
    close: async (fd) => {
      dirFds.delete(fd);
      await nodeAtomicWriteFs.close(fd);
    },
    rename: async (from, to) => {
      steps.push("rename");
      await nodeAtomicWriteFs.rename(from, to);
    },
  };
  return { steps, faults, sync, async };
}

/** An SLO with target 99.9; `availability` defaults to a value that fits `budgetRemaining`. */
export function slo(budgetRemaining: number | null, availability: number | null = 99.95): Slo {
  return {
    target: 99.9,
    windowDays: 30,
    availability: budgetRemaining === null ? null : availability,
    budgetRemaining,
  };
}

/** A check with state; `readings` are `[timestamp, location]` results with `certDaysLeft`. */
export function checkState(
  check: Check,
  over: Partial<CheckStateFields> = {},
  readings: number[] = [],
): CheckWithState {
  const locations = readings.map((timestamp, i) => ({
    location: `loc-${i}`,
    stale: false,
    result: {
      checkId: check.id,
      timestamp,
      status: "up" as const,
      statusCode: null,
      latencyMs: 1,
      reason: null,
      location: `loc-${i}`,
      attempts: 1,
    },
  }));
  return {
    ...check,
    state: "up",
    consecutiveDown: 0,
    lastResultAt: readings.length === 0 ? null : Math.max(...readings),
    lastReason: null,
    locations,
    ...over,
  };
}

export function componentState(
  id: string,
  name: string,
  over: Partial<ComponentWithState> = {},
): ComponentWithState {
  return { id, name, checkIds: ["a"], state: "up", uptime: null, incidentIds: [], ...over };
}

export const WARNING_TIME_MS = Date.UTC(2026, 0, 1, 12, 0, 0);

export function budgetNote(over: Partial<BudgetNotification> = {}): BudgetNotification {
  return {
    key: `budget:check:${WARNING_TIME_MS}:${"a".repeat(32)}`,
    event: "budget-low",
    time: new Date(WARNING_TIME_MS).toISOString(),
    timeMs: WARNING_TIME_MS,
    subject: { kind: "check", id: "api-health", name: "API health" },
    budget: { remaining: 18.4, threshold: 25, target: 99.9, availability: 99.8816, windowDays: 30 },
    ...over,
  };
}

export function expiryNote(over: Partial<ExpiryNotification> = {}): ExpiryNotification {
  return {
    key: `expiry:${WARNING_TIME_MS}:14:${"b".repeat(32)}`,
    event: "tls-expiry",
    time: new Date(WARNING_TIME_MS + 5000).toISOString(),
    timeMs: WARNING_TIME_MS + 5000,
    subject: { kind: "check", id: "site-tls", name: "Site TLS" },
    expiry: { daysLeft: 13, milestone: 14, observedMs: WARNING_TIME_MS },
    ...over,
  };
}

/** The alert-state part of the ledger that the pure rules read and write. */
export type AlertStore = Pick<Ledger, "alertState" | "alertStates" | "applyAlerts">;

/**
 * An in-memory alert store for rule tests that do not reopen the ledger. Like the ledger, an
 * upsert replaces the whole row. Deliveries are not stored.
 */
export function memoryAlerts(): AlertStore {
  const kinds = new Map<AlertKind, Map<string, AlertState>>();
  const rowsOf = (kind: AlertKind): Map<string, AlertState> => {
    const rows = kinds.get(kind) ?? new Map<string, AlertState>();
    kinds.set(kind, rows);
    return rows;
  };
  return {
    alertState: (kind, id) => {
      const row = rowsOf(kind).get(id);
      return row ? { ...row } : undefined;
    },
    alertStates: (kind) => [...rowsOf(kind)].map(([id, row]) => [id, { ...row }]),
    applyAlerts: (changes) => {
      for (const c of changes) rowsOf(c.kind).set(c.subjectId, { ...c.state, updatedAt: 0 });
      return [];
    },
  };
}
