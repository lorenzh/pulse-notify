import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Check, Incident, ManualIncident } from "@lorenzh/pulse-contract";
import {
  type AtomicWriteFs,
  type AtomicWriteSyncFs,
  type Logger,
  type LogLevel,
  nodeAtomicWriteFs,
  nodeAtomicWriteSyncFs,
} from "@lorenzh/pulse-kit";

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
  failing: boolean;
  /** Answers 500 on `/manual-incidents` only. */
  failingManual: boolean;
  /** Paths (like `/checks`) that answer with the given status instead of data. */
  failingPaths: Map<string, number>;
  /** Paths requested so far, in order. */
  requested: string[];
  close(): Promise<void>;
}

export async function startFakeApi(): Promise<FakeApi> {
  const api: FakeApi = {
    url: "",
    incidents: [],
    checks: [],
    manualIncidents: [],
    failing: false,
    failingManual: false,
    failingPaths: new Map(),
    requested: [],
    close: () => close(server),
  };
  const server = createServer((req, res) => {
    api.requested.push(req.url ?? "");
    const failStatus = api.failingPaths.get(req.url ?? "");
    if (api.failing || (api.failingManual && req.url === "/manual-incidents") || failStatus) {
      res.statusCode = failStatus ?? 500;
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    if (req.url === "/incidents") res.end(JSON.stringify(api.incidents));
    else if (req.url === "/manual-incidents" && api.manualIncidents) {
      res.end(JSON.stringify(api.manualIncidents));
    } else if (req.url === "/checks") res.end(JSON.stringify(api.checks));
    else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  api.url = await listen(server);
  return api;
}

export interface ReceivedRequest {
  method: string | undefined;
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
      receiver.requests.push({ method: req.method, headers: req.headers, body, raw, status });
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
