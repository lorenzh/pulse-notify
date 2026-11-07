import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  SUBSCRIPTION_CONFIRM_TOKEN_PATTERN,
  SUBSCRIPTION_MAX_BODY_BYTES,
  SUBSCRIPTION_ROUTES,
  SUBSCRIPTION_UNSUBSCRIBE_TOKEN_PATTERN,
  type SubscriptionAnswer,
  validateSubscriptionRequest,
  validateSubscriptionTokenRequest,
  WIRE_VERSION,
  WIRE_VERSION_HEADER,
} from "@lorenzh/pulse-contract";
import { BodyError, readJsonBody } from "@lorenzh/pulse-kit";
import type { SubscriptionRequestOutcome, SubscriptionRoute } from "./metrics.ts";
import type { SubscriptionOperations } from "./subscription-requests.ts";

/** `headersTimeout` and `requestTimeout` of the listener (R4). */
export const LISTENER_TIMEOUT_MS = 10_000;

export interface SubscriptionServerDeps {
  host: string;
  port: number;
  /** The bearer token of status. */
  token: string;
  ops: SubscriptionOperations;
  now: () => number;
  logError: (message: string, fields?: Record<string, unknown>) => void;
  onRequest?: (route: SubscriptionRoute, outcome: SubscriptionRequestOutcome) => void;
}

export interface SubscriptionServer {
  port: number;
  close: () => Promise<void>;
}

const ROUTES = new Map<string, SubscriptionRoute>([
  [SUBSCRIPTION_ROUTES.subscribe, "subscribe"],
  [SUBSCRIPTION_ROUTES.confirm, "confirm"],
  [SUBSCRIPTION_ROUTES.unsubscribe, "unsubscribe"],
]);

const SUCCESS: Record<SubscriptionRoute, SubscriptionAnswer> = {
  subscribe: { status: "accepted" },
  confirm: { status: "confirmed" },
  unsubscribe: { status: "unsubscribed" },
};

const sha256 = (text: string): Buffer => createHash("sha256").update(text).digest();

function answer(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(payload)),
    "cache-control": "no-store",
    [WIRE_VERSION_HEADER]: String(WIRE_VERSION),
    ...headers,
  });
  res.end(payload);
}

function isJson(req: IncomingMessage): boolean {
  const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  return type === "application/json";
}

type Parsed = { email: string } | { token: string } | undefined;

/** The contract validator and, for a token, the route's pattern; `undefined` is a `400`. */
function parse(route: SubscriptionRoute, body: unknown): Parsed {
  if (route === "subscribe") {
    const v = validateSubscriptionRequest(body);
    return v.ok ? { email: v.value.email } : undefined;
  }
  const v = validateSubscriptionTokenRequest(body);
  if (!v.ok) return undefined;
  const pattern =
    route === "confirm"
      ? SUBSCRIPTION_CONFIRM_TOKEN_PATTERN
      : SUBSCRIPTION_UNSUBSCRIBE_TOKEN_PATTERN;
  return pattern.test(v.value.token) ? { token: v.value.token } : undefined;
}

/**
 * The private listener of R4. Order: path, method, bearer (before any body byte), content type,
 * size, JSON and validator, then the operation. A subscribe is decided and answered in one
 * synchronous step (immediate class, D22). No answer holds an address or a token.
 */
export function startSubscriptionServer(deps: SubscriptionServerDeps): Promise<SubscriptionServer> {
  const expected = sha256(`Bearer ${deps.token}`);
  const isAuthorized = (req: IncomingMessage): boolean =>
    timingSafeEqual(sha256(req.headers.authorization ?? ""), expected);

  const operate = (route: SubscriptionRoute, input: Parsed): SubscriptionRequestOutcome => {
    const now = deps.now();
    if (input !== undefined && "email" in input) return deps.ops.subscribe(input.email, now);
    const token = input?.token ?? "";
    return route === "confirm" ? deps.ops.confirm(token, now) : deps.ops.unsubscribe(token);
  };

  const handleBody = (route: SubscriptionRoute, body: unknown, res: ServerResponse): void => {
    const input = parse(route, body);
    if (input === undefined) {
      deps.onRequest?.(route, "invalid");
      answer(res, 400, { error: "invalid request" });
      return;
    }
    let outcome: SubscriptionRequestOutcome;
    try {
      outcome = operate(route, input);
    } catch (err) {
      deps.logError("subscription operation failed", {
        route,
        error: err instanceof Error ? err.name : "unknown",
      });
      deps.onRequest?.(route, "error");
      answer(res, 503, { error: "unavailable" });
      return;
    }
    deps.onRequest?.(route, outcome);
    if (outcome === "invalid") answer(res, 404, { error: "invalid token" });
    else answer(res, route === "subscribe" ? 202 : 200, SUCCESS[route]);
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const route = ROUTES.get(path);
    if (route === undefined) {
      answer(res, 404, { error: "not found" });
      return;
    }
    if (req.method !== "POST") {
      answer(res, 405, { error: "method not allowed" }, { allow: "POST" });
      return;
    }
    if (!isAuthorized(req)) {
      deps.onRequest?.(route, "unauthorized");
      // The body is never read; closing the connection drops it.
      answer(res, 401, { error: "unauthorized" }, { connection: "close" });
      return;
    }
    if (!isJson(req)) {
      deps.onRequest?.(route, "invalid");
      answer(res, 415, { error: "unsupported media type" }, { connection: "close" });
      return;
    }
    readJsonBody(req, { maxBytes: SUBSCRIPTION_MAX_BODY_BYTES }).then(
      (body) => handleBody(route, body, res),
      (err: unknown) => {
        if (err instanceof BodyError && err.code === "aborted") {
          req.destroy();
          return;
        }
        deps.onRequest?.(route, "invalid");
        if (err instanceof BodyError && err.code === "too-large") {
          answer(res, 413, { error: "payload too large" }, { connection: "close" });
        } else {
          answer(res, 400, { error: "invalid json" });
        }
      },
    );
  };

  const server = createServer(handle);
  const close = (): Promise<void> =>
    new Promise<void>((done) => {
      server.closeAllConnections();
      server.close(() => done());
    });
  server.headersTimeout = LISTENER_TIMEOUT_MS;
  server.requestTimeout = LISTENER_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.port, deps.host, () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        close,
      });
    });
  });
}
