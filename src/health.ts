import { createServer, type Server } from "node:http";

export interface HealthOptions {
  /** `undefined` when ready, else a short reason. */
  notReady: () => string | undefined;
  metrics: () => string;
}

/** Serves `/healthz` and `/metrics`. Unauthenticated: bind it to a private interface. */
export function createHealthServer(opts: HealthOptions): Server {
  return createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "text/plain" }).end("method not allowed\n");
    } else if (path === "/healthz") {
      const reason = opts.notReady();
      res
        .writeHead(reason === undefined ? 200 : 503, { "content-type": "text/plain" })
        .end(reason === undefined ? "ok\n" : `${reason}\n`);
    } else if (path === "/metrics") {
      res
        .writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" })
        .end(opts.metrics());
    } else {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
    }
  });
}

/** Stops accepting connections and drops idle and open ones. */
export function closeHealthServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
