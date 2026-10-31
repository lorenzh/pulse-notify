# Install and run

pulse-notify needs a running pulse-api and a channel config file (see [configuration.md](configuration.md)).

## Bun

Requires Bun 1.4.0.

```sh
bun install --frozen-lockfile
PULSE_NOTIFY_CONFIG=./notify.json PULSE_API_URL=http://localhost:3000 bun run start
```

`bun run start` runs `bun src/index.ts`. The source runs unbuilt with Bun. Stop it with `SIGINT` or `SIGTERM`; it exits with code 0 after a clean stop, or with code 1 when the stop takes longer than 5 seconds.

If `PULSE_NOTIFY_CONFIG` is missing or the config is invalid, it prints `pulse-notify: <message>` to stderr and exits with code 2.

## Docker

```sh
docker build --tag pulse-notify:local .
docker run --rm \
  -v "$PWD/notify.json:/config/notify.json:ro" \
  -v pulse-notify-data:/data \
  -e PULSE_NOTIFY_CONFIG=/config/notify.json \
  -e PULSE_API_URL=http://host.docker.internal:3000 \
  pulse-notify:local
```

- The image runs as the non-root `bun` user and starts `bun --no-env-file src/index.ts`. It has a `HEALTHCHECK` that fetches `http://127.0.0.1:$PULSE_HEALTH_PORT/healthz` (9100 when the variable is unset or empty, read at run time; a value that is not 1 to 5 digits fails the check without a request, and port 0 is not supported) every 30 seconds (5 second timeout, 10 second start period, 3 retries) and is unhealthy when the request fails or the status is not 2xx. `/healthz` reports the lifecycle only, so an unreachable pulse-api does not make the container unhealthy. The image sets `PULSE_HEALTH_PORT=9100`; see [operation.md](operation.md#health-and-metrics).
- The service and its healthcheck run Bun with `--no-env-file`, so they read no `.env` files, also not ones mounted into `/app`. Settings come from the container environment (`-e`, `docker run --env-file` read on the host, Compose `environment:` or `env_file:`) and the files that the settings name, such as `PULSE_NOTIFY_CONFIG` and the channel `secretFile`/`urlFile` keys.
- The image contains no config. Mount your file and point `PULSE_NOTIFY_CONFIG` at it.
- `/data` is owned by `bun`. The image sets `PULSE_NOTIFY_STATE=/data/notify-state.json`. Mount a volume at `/data` to keep the delivery ledger across restarts. See [operation.md](operation.md).
- A `file` channel needs a path under a writable directory such as `/data`, for example `/data/incidents.jsonl`.
- The image holds only production dependencies and `src`, and no secrets.

## With the full stack

[pulse-api](https://github.com/lorenzh/pulse-api/blob/main/docs/install.md) ships a Compose file that runs notify with the other services.
