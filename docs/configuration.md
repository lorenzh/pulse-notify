# Configuration

pulse-notify reads environment variables and one JSON config file. Both are read once at start. Restart to apply a change.

## Environment variables

| Variable                               | Default                 | Meaning                                                                                                                                                                     |
| -------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PULSE_NOTIFY_CONFIG`                  | required                | Path to the channel config file                                                                                                                                             |
| `PULSE_API_URL`                        | `http://localhost:3000` | pulse-api base URL                                                                                                                                                          |
| `PULSE_NOTIFY_STATE`                   | `./notify-state.json`   | Delivery ledger file, see [operation.md](operation.md)                                                                                                                      |
| `PULSE_NOTIFY_POLL_MS`                 | `5000`                  | Poll interval in milliseconds, at least 1                                                                                                                                   |
| `PULSE_NOTIFY_RETRY_DELAY_MS`          | `1000`                  | Initial delay before the first retry in milliseconds; it doubles per retry                                                                                                  |
| `PULSE_NOTIFY_RETRY_MAX_DELAY_MS`      | `60000`                 | Cap of the delay between attempts, at least the initial delay                                                                                                               |
| `PULSE_NOTIFY_RETRY_ATTEMPTS`          | `12`                    | Total attempts per event; `0` retries without end                                                                                                                           |
| `PULSE_NOTIFY_TIMEOUT_MS`              | `5000`                  | Timeout per webhook attempt and per api request, at least 1. It covers reading the response body. For an email channel it covers one whole attempt, from connect to `QUIT`. |
| `PULSE_NOTIFY_HEALTH_MAX_FAILED_POLLS` | `5`                     | `/healthz` returns 503 after this many failed polls in a row, at least 1. See [operation.md](operation.md#health-and-metrics).                                              |
| `PULSE_NOTIFY_LOCK_LEASE_SECONDS`      | `60`                    | Lease of the state file lock, at least 30. The holder refreshes it every lease/6. See [operation.md](operation.md#state-file-lock).                                         |
| `PULSE_NOTIFY_STATE_RETENTION_DAYS`    | `30`                    | Settled ledger entries older than this are pruned, at least 1. See [operation.md](operation.md#state-the-delivery-ledger).                                                  |
| `PULSE_NOTIFY_API_MAX_BYTES`           | `5242880`               | Largest API response body in bytes (5 MiB), at least 1. A larger body fails the poll.                                                                                       |
| `PULSE_NOTIFY_SMTP_CLIENT_NAME`        | host name               | Name sent with `EHLO` by email channels: a host name or an address literal. See [email.md](channels/email.md).                                                              |
| `PULSE_LOG_LEVEL`                      | `info`                  | `debug`, `info`, `warn` or `error`. Another value stops startup.                                                                                                            |
| `PULSE_HEALTH_PORT`                    | unset                   | Port of the health and metrics listener, see [operation.md](operation.md). Unset means no listener.                                                                         |
| `PULSE_HEALTH_HOST`                    | `127.0.0.1`             | Address of that listener. The Docker image sets `0.0.0.0` and port `9100`.                                                                                                  |

The schedule is in [channels.md](channels.md#delivery-and-retries).

- The numeric variables must be integers within their bound. Anything else stops startup with `<NAME>: must be an integer of at least <min>`, for example `PULSE_NOTIFY_POLL_MS: must be an integer of at least 1`. `PULSE_NOTIFY_RETRY_ATTEMPTS` allows `0`: `PULSE_NOTIFY_RETRY_ATTEMPTS: must be an integer >= 0`.
- `PULSE_NOTIFY_RETRY_MAX_DELAY_MS` below `PULSE_NOTIFY_RETRY_DELAY_MS` stops startup with `PULSE_NOTIFY_RETRY_MAX_DELAY_MS: must be at least PULSE_NOTIFY_RETRY_DELAY_MS`.
- `PULSE_API_URL` must be an `http:` or `https:` URL. The startup log and every log line or error that carries it show the URL without user info, query and fragment; an error about it never repeats the value.
- An empty value counts as unset, so the default applies.
- Example: `PULSE_NOTIFY_POLL_MS=30000` polls every 30 seconds.

## Channel config file

A shape error in a channel names the channel id, for example `channel "mail": smtp.port must be an integer from 1 to 65535`. This form is deliberate: the id tells which channel to fix. An error about the file as a whole reads `config must be an object`.

`PULSE_NOTIFY_CONFIG` points to a JSON file:

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

Top level:

| Key        | Required | Meaning                            |
| ---------- | -------- | ---------------------------------- |
| `channels` | yes      | Non-empty array of channel objects |

Every channel:

| Key                  | Required | Meaning                                                                                                              |
| -------------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `id`                 | yes      | Non-empty string, unique in the file. The delivery ledger is keyed by it.                                            |
| `type`               | yes      | `webhook`, `file`, `slack`, `teams` or `email`                                                                       |
| `checks`             | no       | Check ids or `*` globs. Absent or empty means all checks. Unknown ids are allowed and match nothing.                 |
| `excludeChecks`      | no       | Check ids or `*` globs to skip. Wins over `checks`. See [routing](channels.md#routing).                              |
| `components`         | no       | Component ids for manual incidents. Absent or empty means all. See [manual incidents](channels.md#manual-incidents). |
| `excludeComponents`  | no       | Component ids whose manual incidents are skipped. Wins over `components`.                                            |
| `remindEverySeconds` | no       | Integer of at least 60. Sends a `reminder` while an incident is open. See [reminders](channels.md#reminders).        |

Per type:

| Type             | Key                        | Required | Meaning                                                                                                                                                |
| ---------------- | -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `webhook`        | `url`                      | yes      | A valid `http:` or `https:` URL. `http:` to a remote host logs a warning.                                                                              |
| `webhook`        | `secretEnv` / `secretFile` | no       | Signing secret, see [webhook.md](channels/webhook.md#signing)                                                                                          |
| `file`           | `path`                     | yes      | Non-empty file path. The parent directory is created.                                                                                                  |
| `slack`, `teams` | `urlEnv` / `urlFile`       | one of   | Where the `https:` webhook URL is read from; `statusUrl`, `hideReason` are optional. See [slack.md](channels/slack.md), [teams.md](channels/teams.md). |
| `email`          | `smtp`, `from`, `to`       | yes      | See [email.md](channels/email.md).`subjectPrefix`, `statusUrl`, `hideReason` are optional.                                                             |

Unknown keys are rejected at startup, for example `notify.json: unknown key "check" in channels[0]`. Check the spelling of `checks`. The place is a path, so an unknown key inside the SMTP block reads `notify.json: unknown key "extra" in channels[0].smtp`. Details of each channel are in [channels.md](channels.md).

Secrets and credential URLs (Slack, Teams, SMTP password, webhook signing secret) are read from environment variables or files, see [secrets](channels.md#secrets). Relative secret file paths are relative to the working directory. Do not put secrets in a webhook `url`: the config file holds it in clear text. pulse-notify does not log URLs.

An invalid config stops startup with `pulse-notify: <message>` and exit code 2. The messages are listed in [troubleshooting.md](troubleshooting.md).
