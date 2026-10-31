# pulse-notify

[![CI](https://github.com/lorenzh/pulse-notify/actions/workflows/ci.yml/badge.svg)](https://github.com/lorenzh/pulse-notify/actions/workflows/ci.yml)

pulse is an uptime monitor with a status page. This repository is its notifier: a long-running service that polls [pulse-api](https://github.com/lorenzh/pulse-api) (`GET /incidents`, `GET /checks` and `GET /manual-incidents`) and sends a notification (check name, reason, time) to the configured channels when an incident opens or resolves, and when a manual incident is opened, updated or resolved (an older api without `/manual-incidents` is tolerated), and optionally "still down" reminders while it stays open. Channels: `webhook` (optionally HMAC-signed), `file`, `slack`, `teams` and `email` (SMTP). Each channel can include or exclude checks by id or `*` pattern, and route manual incidents by component; secrets come from environment variables or files. The contract has no tags, so routing is by check id. It uses the `Incident` and `Check` types of [pulse-contract](https://github.com/lorenzh/pulse-contract).

Failed events keep their notification and can be listed and resent with `bun src/index.ts failed list` and `failed resend <key>|--all [--channel <id>]` while the service is stopped, see [docs/operation.md](docs/operation.md#failed-events-and-resend). A 4xx answer (except 408 and 429) from an HTTP receiver and a 5xx SMTP reply are permanent errors and end the event at once. `/healthz` and `/readyz` turn 503 when polls keep failing.

pulse is built by Paragon Factory agents from the issues in [pulse-meta](https://github.com/lorenzh/pulse-meta).

Contributing: see [AGENTS.md](AGENTS.md).

## Quick start

Requires Bun 1.4.0 and a running pulse-api. Write a config file such as `notify.json`:

```json
{ "channels": [{ "id": "log", "type": "file", "path": "./incidents.jsonl" }] }
```

In Docker, use `"path": "/data/incidents.jsonl"` instead. Only `/data` is writable there.

```sh
bun install --frozen-lockfile
PULSE_NOTIFY_CONFIG=./notify.json PULSE_API_URL=http://localhost:3000 bun run start
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

Released images are published as `ghcr.io/lorenzh/pulse-notify` for linux/amd64 and linux/arm64. Use one in place of `pulse-notify:local`, and pin it by digest in a setup:

```sh
docker pull ghcr.io/lorenzh/pulse-notify:0.1.0
```

Tags, the release gate and provenance checks are in [Releasing](docs/development.md#releasing).

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

`bun run check` runs lint, typecheck and tests. See [docs/development.md](docs/development.md).

Licensed under the MIT licence, see [LICENSE](LICENSE).

## Shared tooling configuration

The shared tooling configuration lives in `lorenzh/pulse-config`. The other pulse repositories use it through `extends` (Biome, TypeScript, Lefthook), a one-line ESLint config and `uses:` (CI). A rule change is made in `pulse-config` and reaches a target when its pin is updated. "Never weaken `biome.json`, `tsconfig.json` or CI" refers to the shared config.
