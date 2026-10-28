# pulse-notify

[![CI](https://github.com/lorenzh/pulse-notify/actions/workflows/ci.yml/badge.svg)](https://github.com/lorenzh/pulse-notify/actions/workflows/ci.yml)

pulse is an uptime monitor with a status page. This repository is its notifier: a long-running service that polls [pulse-api](https://github.com/lorenzh/pulse-api) (`GET /incidents` and `GET /checks`) and sends a notification (check name, reason, time) to the configured channels when an incident opens or resolves. It uses the `Incident` and `Check` types of [pulse-contract](https://github.com/lorenzh/pulse-contract).

pulse is built by Paragon Factory agents from the issues in [pulse-meta](https://github.com/lorenzh/pulse-meta).

Contributing: see [AGENTS.md](AGENTS.md).

## Checks

`npm run lint` runs Biome and SonarJS via ESLint (cognitive complexity ≤ 15); `npm test` runs the tests and requires line coverage ≥ 80 %.

## Configuration

`PULSE_NOTIFY_CONFIG` points to a JSON file (required):

```json
{
  "channels": [
    {
      "id": "ops-hook",
      "type": "webhook",
      "url": "https://example.com/hook",
      "checks": ["example"]
    },
    { "id": "log", "type": "file", "path": "./incidents.jsonl" }
  ]
}
```

- `id`: unique channel id (the delivery ledger is keyed by it).
- `type`: `webhook` (needs an http(s) `url`) or `file` (needs a `path`; the parent directory is created).
- `checks`: optional list of check ids; absent or empty means all checks. Unknown ids are allowed.

An invalid config stops startup with a `ConfigError` and a message.

| Variable                      | Default                 | Meaning                                         |
| ----------------------------- | ----------------------- | ----------------------------------------------- |
| `PULSE_NOTIFY_CONFIG`         | required                | Path to the channel config file                 |
| `PULSE_API_URL`               | `http://localhost:3000` | pulse-api base URL                              |
| `PULSE_NOTIFY_STATE`          | `./notify-state.json`   | Delivery ledger file (written atomically)       |
| `PULSE_NOTIFY_POLL_MS`        | `5000`                  | Poll interval                                   |
| `PULSE_NOTIFY_RETRY_DELAY_MS` | `1000`                  | Delay between delivery attempts                 |
| `PULSE_NOTIFY_TIMEOUT_MS`     | `5000`                  | Timeout per webhook attempt and per api request |

## Notification payload

The webhook body and each line of the file channel are the same JSON object:

```json
{
  "key": "12:opened",
  "event": "opened",
  "incidentId": 12,
  "checkId": "example",
  "checkName": "Example site",
  "reason": "HTTP 503",
  "time": "2026-01-01T12:00:00.000Z",
  "timeMs": 1767268800000
}
```

`event` is `opened` or `resolved`. `time` is the event time (`openedAt` or `resolvedAt`), not the delivery time. `reason` is the incident's opening reason. If the check name is unknown, `checkName` is the check id. The webhook is a `POST` with `content-type: application/json` and an `idempotency-key: <key>` header; 2xx is success, anything else (including redirects, which are not followed) or a timeout is a failure.

## Delivery guarantees

- At most once. Before the first send, `(channel, key)` is recorded as `pending` in the ledger, then `delivered` or `failed`. A claim is never sent again. At startup every `pending` entry is logged at error level as "possibly lost" (a crash between claim and send loses that one notification).
- Each event gets 4 attempts (3 retries). After that it is logged at error level (channel, key, attempts, last error) and never retried, not even after a restart.
- Each channel has its own FIFO queue and worker, so a slow or failing channel delays neither other channels nor polling. `resolved` is sent after `opened`; it is still sent if `opened` failed.
- On the first start of a channel (new ledger or new channel id) all currently visible incidents are recorded as `seeded`: no notifications for history.
- A failing api poll is logged and retried on the next tick. `stop()` does not drain queues; unclaimed events are detected again on the next start.
- Logs are JSON lines on stderr.

## Run

```sh
PULSE_NOTIFY_CONFIG=./notify.json PULSE_API_URL=http://localhost:3000 npm start
```

## Install

Requires Node 24 or newer.

```sh
npm ci
```

## Development

```sh
npm run check   # lint, typecheck and tests
npm test        # tests only
npm run lint    # Biome format and lint check, changes nothing
npm run format  # Biome: apply formatting and safe lint fixes
```

`npm ci` installs a Lefthook pre-commit hook that runs `biome check` on the staged files and rejects the commit if they are badly formatted or fail lint. Run `npm run format` to fix them.

Licensed under the MIT licence, see [LICENSE](LICENSE).

## Shared tooling configuration

The shared tooling configuration lives in `lorenzh/pulse-config`. The other pulse repositories use it through `extends` (Biome, TypeScript, Lefthook), a one-line ESLint config and `uses:` (CI). A rule change is made in `pulse-config` and reaches a target when its pin is updated. "Never weaken `biome.json`, `tsconfig.json` or CI" refers to the shared config.
