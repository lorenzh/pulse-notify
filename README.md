# pulse-notify

[![CI](https://github.com/lorenzh/pulse-notify/actions/workflows/ci.yml/badge.svg)](https://github.com/lorenzh/pulse-notify/actions/workflows/ci.yml)

pulse is an uptime monitor with a status page. This repository is its notifier: a long-running service that polls [pulse-api](https://github.com/lorenzh/pulse-api) (`GET /incidents`, `GET /checks` and `GET /manual-incidents`) and sends a notification (check name, reason, time) to the configured channels when an incident opens or resolves, and when a public manual incident is opened, updated or resolved (an older api without `/manual-incidents` is tolerated; drafts, internal notes and internal-only incidents are never sent, which needs pulse-contract `2.1.0`), and optionally "still down" reminders while it stays open. A channel can also opt in to warnings: `budget-low` (the error budget of a check or component SLO is low, at most once per 24 hours) and `tls-expiry` / `domain-expiry` (one warning at 14 days and one at 3 days per expiry episode), see [docs/channels.md](docs/channels.md#warnings). `GET /components` is read only for `budget-low`; `PULSE_NOTIFY_BUDGET_THRESHOLD` (default 25) sets the threshold, and `sendIncidents: false` makes a warning-only channel. Channels: `webhook` (optionally HMAC-signed), `file`, `slack`, `teams` and `email` (SMTP). Each channel can include or exclude checks by id or `*` pattern, and route manual incidents by component; a filter change sends no burst for the history of newly routed checks; secrets come from environment variables or files. The contract has no tags, so routing is by check id. It uses the `Incident` and `Check` types of [pulse-contract](https://github.com/lorenzh/pulse-contract).

Failed events keep their notification and can be listed and resent with `bun src/index.ts failed list` and `failed resend <key>|--all [--channel <id>]` while the service is stopped, see [docs/operation.md](docs/operation.md#failed-events-and-resend). A 4xx answer (except 408 and 429) from an HTTP receiver and a 5xx SMTP reply are permanent errors and end the event at once. When an SMTP server refuses some recipients, a retry goes only to the recipients that still need the message, see [docs/channels/email.md](docs/channels/email.md). An event that waits for a retry does not block its channel: later events are sent meanwhile, so a retried event can arrive after a later one. `/readyz` turns 503 when polls keep failing; `/healthz` stays 200 while the poll loop runs. The state file is a SQLite database (format 5); a JSON state file or a format-3 or format-4 database is migrated once at start (the SQLite original is kept as a private `<state>.v3.bak` or `<state>.v4.bak`), and a backup needs a stopped service. After an upgrade, read the [upgrade note](docs/operation.md#upgrading). With `PULSE_NOTIFY_API_TOKEN`, notify also polls the database channels every `PULSE_NOTIFY_CHANNELS_POLL_MS`, reloads the channel file without a restart and reports its state to the api after every channel poll and at least every 60000 ms, measured from the start of one report to the start of the next (a slow report up to the 5000 ms service timeout or a long `PULSE_NOTIFY_CHANNELS_POLL_MS` does not stretch that interval; reports run one at a time, and reports that come due while one is running wait and are sent as one), and runs resend commands from the console every `PULSE_NOTIFY_COMMAND_POLL_MS` (see [docs/operation.md](docs/operation.md#live-resend)), see [docs/channels.md](docs/channels.md#database-channels).

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

The image starts `bun --no-env-file src/index.ts`, so a `.env` mounted into `/app` is not read. Settings come from `-e`, `docker run --env-file` (read on the host), Compose, or the files named by the `secretFile`/`urlFile` channel keys ([configuration](docs/configuration.md)).

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

Email subscriptions for status page visitors are opt-in with `PULSE_NOTIFY_SUBSCRIPTIONS=on` (default `off`; with `off` nothing of them starts and `/metrics` is unchanged). Then notify opens a private subscriber store (`notify-subscriptions.db` beside the ledger, mode `0600`, its own lock), answers status on a private listener (`PULSE_NOTIFY_SUBSCRIPTIONS_HOST:PORT`, default `127.0.0.1:9300`, Bearer token required) that binds before the notifier starts, sends confirmation mail, and sends each new public manual incident event to every confirmed subscriber, one email per mailbox at a time. Email subscriptions need the status page at the root of its origin, for example `https://status.example.com`. A path such as `/pulse` is refused at startup while subscriptions are on. The settings are in [docs/configuration.md](docs/configuration.md#email-subscriptions); the store, its data inventory and 25-hour cleanup of unconfirmed addresses, `bun src/index.ts subscribers delete <address>`, backups, key rotation and the known limits D-R1..D-R13 are in [docs/operation.md](docs/operation.md#subscriber-store).

## Development

`bun run check` runs lint, typecheck and tests. See [docs/development.md](docs/development.md).

Licensed under the MIT licence, see [LICENSE](LICENSE).

## Shared tooling configuration

The shared tooling configuration lives in `lorenzh/pulse-config`. The other pulse repositories use it through `extends` (Biome, TypeScript, Lefthook), a one-line ESLint config and `uses:` (CI). A rule change is made in `pulse-config` and reaches a target when its pin is updated. "Never weaken `biome.json`, `tsconfig.json` or CI" refers to the shared config.
