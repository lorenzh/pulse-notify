# pulse-notify

[![CI](https://github.com/lorenzh/pulse-notify/actions/workflows/ci.yml/badge.svg)](https://github.com/lorenzh/pulse-notify/actions/workflows/ci.yml)

pulse is an uptime monitor with a status page. This repository is its notifier: a long-running service that polls [pulse-api](https://github.com/lorenzh/pulse-api) (`GET /incidents` and `GET /checks`) and sends a notification (check name, reason, time) to the configured channels when an incident opens or resolves, and optionally "still down" reminders while it stays open. Channels: `webhook` (optionally HMAC-signed), `file`, `slack`, `teams` and `email` (SMTP). Each channel can include or exclude checks by id or `*` pattern; secrets come from environment variables or files. The contract has no tags, so routing is by check id. It uses the `Incident` and `Check` types of [pulse-contract](https://github.com/lorenzh/pulse-contract).

Failed events keep their notification and can be listed and resent with `node src/index.ts failed list` and `failed resend <key>|--all [--channel <id>]` while the service is stopped, see [docs/operation.md](docs/operation.md#failed-events-and-resend). A 4xx answer (except 408 and 429) from an HTTP receiver and a 5xx SMTP reply are permanent errors and end the event at once. `/healthz` turns 503 when polls keep failing.

pulse is built by Paragon Factory agents from the issues in [pulse-meta](https://github.com/lorenzh/pulse-meta).

Contributing: see [AGENTS.md](AGENTS.md).

## Quick start

Requires Node 24 or newer and a running pulse-api. Write a config file such as `notify.json`:

```json
{ "channels": [{ "id": "log", "type": "file", "path": "./incidents.jsonl" }] }
```

In Docker, use `"path": "/data/incidents.jsonl"` instead. Only `/data` is writable there.

```sh
npm ci
PULSE_NOTIFY_CONFIG=./notify.json PULSE_API_URL=http://localhost:3000 npm start
```

With Docker:

```sh
docker build --tag pulse-notify:local .
docker run --rm \
  -v "$PWD/notify.json:/config/notify.json:ro" \
  -v pulse-notify-data:/data \
  -e PULSE_NOTIFY_CONFIG=/config/notify.json \
  -e PULSE_API_URL=http://host.docker.internal:3000 \
  pulse-notify:local
```

## Documentation

Settings, channels, routing, reminders, secrets, signing, payload, delivery, operation and troubleshooting are in [docs/index.md](docs/index.md). A Slack example:

```json
{
  "channels": [
    { "id": "slack", "type": "slack", "urlEnv": "SLACK_WEBHOOK_URL", "remindEverySeconds": 3600 }
  ]
}
```

Settings (environment variables) are listed in [docs/configuration.md](docs/configuration.md); the channel config keys are there too.

## Development

`npm run check` runs lint, typecheck and tests. See [docs/development.md](docs/development.md).

Licensed under the MIT licence, see [LICENSE](LICENSE).

## Shared tooling configuration

The shared tooling configuration lives in `lorenzh/pulse-config`. The other pulse repositories use it through `extends` (Biome, TypeScript, Lefthook), a one-line ESLint config and `uses:` (CI). A rule change is made in `pulse-config` and reaches a target when its pin is updated. "Never weaken `biome.json`, `tsconfig.json` or CI" refers to the shared config.
