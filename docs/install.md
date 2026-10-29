# Install and run

pulse-notify needs a running pulse-api and a channel config file (see [configuration.md](configuration.md)).

## npm

Requires Node 24 or newer.

```sh
npm ci
PULSE_NOTIFY_CONFIG=./notify.json PULSE_API_URL=http://localhost:3000 npm start
```

`npm start` runs `node src/index.ts`. The source runs unbuilt with Node type stripping. Stop it with `SIGINT` or `SIGTERM`; it exits with code 0.

If `PULSE_NOTIFY_CONFIG` is missing or the config is invalid, it prints `configuration error: <message>` to stderr and exits with code 2.

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

- The image runs as the non-root `node` user and starts `node src/index.ts`. It has no healthcheck and exposes no port.
- The image contains no config. Mount your file and point `PULSE_NOTIFY_CONFIG` at it.
- `/data` is owned by `node`. The image sets `PULSE_NOTIFY_STATE=/data/notify-state.json`. Mount a volume at `/data` to keep the delivery ledger across restarts. See [operation.md](operation.md).
- A `file` channel needs a path under a writable directory such as `/data`, for example `/data/incidents.jsonl`.
- The image holds only production dependencies and `src`, and no secrets.

## With the full stack

[pulse-api](https://github.com/lorenzh/pulse-api/blob/main/docs/install.md) ships a Compose file that runs notify with the other services.
