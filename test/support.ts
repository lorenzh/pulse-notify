import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Check, Incident } from "@lorenzh/pulse-contract";
import type { Logger, LogLevel } from "@lorenzh/pulse-kit";

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
  failing: boolean;
  close(): Promise<void>;
}

export async function startFakeApi(): Promise<FakeApi> {
  const api: FakeApi = {
    url: "",
    incidents: [],
    checks: [],
    failing: false,
    close: () => close(server),
  };
  const server = createServer((req, res) => {
    if (api.failing) {
      res.statusCode = 500;
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    if (req.url === "/incidents") res.end(JSON.stringify(api.incidents));
    else if (req.url === "/checks") res.end(JSON.stringify(api.checks));
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

/** Narrows a received body to a JSON object, failing the test otherwise. */
export function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("expected a JSON object body");
  }
  return body as Record<string, unknown>;
}
