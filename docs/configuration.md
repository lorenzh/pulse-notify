# Configuration

pulse-notify reads environment variables and one JSON config file. Both are read once at start. Restart to apply a change.

## Environment variables

| Variable                               | Default                 | Meaning                                                                                                                                                                                                                     |
| -------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PULSE_NOTIFY_CONFIG`                  | required                | Path to the channel config file. Optional with a service token: then the file may be absent or list `"channels": []` (database-only mode).                                                                                  |
| `PULSE_NOTIFY_API_TOKEN`               | unset                   | The notify service token of the api, sent as `Bearer` on `/service/*` only, never on the public reads. Set only one of it and `PULSE_NOTIFY_API_TOKEN_FILE`; both stop startup with exit code 2.                            |
| `PULSE_NOTIFY_API_TOKEN_FILE`          | unset                   | File that holds the service token (trimmed). An unreadable or empty file stops startup with exit code 2; the message never shows the token. An empty value counts as unset.                                                 |
| `PULSE_NOTIFY_SECRET_DIR`              | unset                   | Directory of the secret files of database channels. Unset refuses their `urlFile`, `secretFile` and `smtp.passwordFile` with `secret files are not enabled`.                                                                |
| `PULSE_NOTIFY_CHANNELS_POLL_MS`        | `15000`                 | Poll interval of the database channels and of the channel file, at least 1000                                                                                                                                               |
| `PULSE_NOTIFY_COMMAND_POLL_MS`         | `5000`                  | Poll interval of the resend commands (token only), at least 1000                                                                                                                                                            |
| `PULSE_API_URL`                        | `http://localhost:3000` | pulse-api base URL                                                                                                                                                                                                          |
| `PULSE_NOTIFY_STATE`                   | `./notify-state.json`   | Delivery ledger, a SQLite database with `-wal` and `-shm` files beside it (the name keeps `.json`), see [operation.md](operation.md)                                                                                        |
| `PULSE_NOTIFY_POLL_MS`                 | `5000`                  | Poll interval in milliseconds, from 1 to 2147483647                                                                                                                                                                         |
| `PULSE_NOTIFY_RETRY_DELAY_MS`          | `1000`                  | Initial delay before the first retry in milliseconds, at most 2147483647; it doubles per retry                                                                                                                              |
| `PULSE_NOTIFY_RETRY_MAX_DELAY_MS`      | `60000`                 | Cap of the delay between attempts, at least the initial delay and at most 2147483647                                                                                                                                        |
| `PULSE_NOTIFY_RETRY_ATTEMPTS`          | `12`                    | Total attempts per event; `0` retries without end                                                                                                                                                                           |
| `PULSE_NOTIFY_TIMEOUT_MS`              | `5000`                  | Timeout per webhook attempt and per api request, from 1 to 2147483647. It covers reading the response body. For an email channel it covers one whole attempt, from connect to `QUIT`.                                       |
| `PULSE_NOTIFY_HEALTH_MAX_FAILED_POLLS` | `5`                     | `/readyz` returns 503 after this many failed polls in a row, at least 1. `/healthz` does not use it. See [operation.md](operation.md#health-and-metrics).                                                                   |
| `PULSE_NOTIFY_LOCK_LEASE_SECONDS`      | `60`                    | Lease of the state file lock, from 30 to 12884901. The holder refreshes it every lease/6. See [operation.md](operation.md#state-file-lock).                                                                                 |
| `PULSE_NOTIFY_STATE_RETENTION_DAYS`    | `30`                    | Settled ledger entries older than this are pruned, at least 1. See [operation.md](operation.md#state-the-delivery-ledger).                                                                                                  |
| `PULSE_NOTIFY_BUDGET_THRESHOLD`        | `25`                    | A `budget-low` warning fires when the error budget left is strictly below this percent, an integer from 0 to 100. A change takes effect at the next start and resets no stored state. See [warnings](channels.md#warnings). |
| `PULSE_NOTIFY_API_MAX_BYTES`           | `5242880`               | Largest API response body in bytes (5 MiB), at least 1. A larger body fails the poll.                                                                                                                                       |
| `PULSE_NOTIFY_SMTP_CLIENT_NAME`        | host name               | Name sent with `EHLO` by email channels: a host name or an address literal. See [email.md](channels/email.md).                                                                                                              |
| `PULSE_LOG_LEVEL`                      | `info`                  | `debug`, `info`, `warn` or `error`. Another value stops startup.                                                                                                                                                            |
| `PULSE_HEALTH_PORT`                    | unset                   | Port of the health and metrics listener, see [operation.md](operation.md). Unset means no listener.                                                                                                                         |
| `PULSE_HEALTH_HOST`                    | `127.0.0.1`             | Address of that listener. The Docker image sets `0.0.0.0` and port `9100`; its healthcheck follows `PULSE_HEALTH_PORT`.                                                                                                     |

The service token, from `PULSE_NOTIFY_API_TOKEN` or `PULSE_NOTIFY_API_TOKEN_FILE`, may hold only visible ASCII characters. A token with a space, a control character or a non-ASCII character stops startup with exit code 2; the message never shows the token.

The schedule is in [channels.md](channels.md#delivery-and-retries).

- The numeric variables must be integers within their bound. Anything else stops startup. A setting with only a lower bound reports `<NAME>: must be an integer of at least <min>`, for example `PULSE_NOTIFY_STATE_RETENTION_DAYS: must be an integer of at least 1`. A setting with both bounds reports `<NAME>: must be an integer from <min> to <max>`, for example `PULSE_NOTIFY_POLL_MS: must be an integer from 1 to 2147483647` or `PULSE_NOTIFY_LOCK_LEASE_SECONDS: must be an integer from 30 to 12884901`. `PULSE_NOTIFY_RETRY_ATTEMPTS` is a count with no upper bound and reports `PULSE_NOTIFY_RETRY_ATTEMPTS: must be an integer >= 0`. Timer settings stop at 2147483647 ms, the largest timer delay; the lease stops at 12884901 s, so its heartbeat (lease / 6) stays within that bound.
- `PULSE_NOTIFY_RETRY_MAX_DELAY_MS` below `PULSE_NOTIFY_RETRY_DELAY_MS` stops startup with `PULSE_NOTIFY_RETRY_MAX_DELAY_MS: must be at least PULSE_NOTIFY_RETRY_DELAY_MS`.
- `PULSE_API_URL` must be an `http:` or `https:` URL. The startup log and every log line or error that carries it show the URL without user info, query and fragment; an error about it never repeats the value.
- An empty value counts as unset, so the default applies.
- Example: `PULSE_NOTIFY_POLL_MS=30000` polls every 30 seconds.
- Service reads (`/service/*`) use a timeout of 5000 ms, follow no redirect and read at most 1048576 bytes, whatever `PULSE_NOTIFY_API_MAX_BYTES` says.

## Email subscriptions (in progress)

Email subscriptions for status page visitors are being built. This version reads and checks the settings below and has the subscriber store, but the service does not start a listener, store or worker yet, whatever `PULSE_NOTIFY_SUBSCRIPTIONS` says.

| Variable                                        | Default                                               | Rule                                                                                                                                                              |
| ----------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PULSE_NOTIFY_SUBSCRIPTIONS`                    | `off`                                                 | `on` or `off`. The variables below are read only when `on`.                                                                                                       |
| `PULSE_NOTIFY_SUBSCRIPTIONS_STATUS_URL`         | required                                              | The status page origin: an http(s) URL without credentials, query, fragment or path. A trailing `/` is removed.                                                   |
| `PULSE_NOTIFY_SUBSCRIPTIONS_FROM`               | required                                              | A single-line sender address.                                                                                                                                     |
| `PULSE_NOTIFY_SUBSCRIPTIONS_SUBJECT_PREFIX`     | `[<host of STATUS_URL>]`                              | A single line of 1 to 64 characters.                                                                                                                              |
| `PULSE_NOTIFY_SUBSCRIPTIONS_SMTP_HOST`          | required                                              | SMTP host name.                                                                                                                                                   |
| `PULSE_NOTIFY_SUBSCRIPTIONS_SMTP_PORT`          | `587`                                                 | 1 to 65535.                                                                                                                                                       |
| `PULSE_NOTIFY_SUBSCRIPTIONS_SMTP_TLS`           | `starttls`                                            | `starttls`, `tls` or `none`. With a username, `none` is refused unless the host is `127.0.0.1`, `localhost` or `::1`.                                             |
| `PULSE_NOTIFY_SUBSCRIPTIONS_SMTP_USERNAME`      | unset                                                 | A single line. Needs the password file.                                                                                                                           |
| `PULSE_NOTIFY_SUBSCRIPTIONS_SMTP_PASSWORD_FILE` | unset                                                 | A file with the password on one line, read once at startup. Set only together with the username.                                                                  |
| `PULSE_NOTIFY_SUBSCRIPTIONS_TOKEN_FILE`         | required                                              | The bearer token that status sends: one line of at least 32 printable ASCII characters.                                                                           |
| `PULSE_NOTIFY_SUBSCRIPTIONS_KEY_FILE`           | required                                              | The HMAC key of the unsubscribe links: exactly 64 lowercase hex characters.                                                                                       |
| `PULSE_NOTIFY_SUBSCRIPTIONS_HOST`               | `127.0.0.1`                                           | Listener address.                                                                                                                                                 |
| `PULSE_NOTIFY_SUBSCRIPTIONS_PORT`               | `9300`                                                | Listener port.                                                                                                                                                    |
| `PULSE_NOTIFY_SUBSCRIPTIONS_STATE`              | `notify-subscriptions.db` beside `PULSE_NOTIFY_STATE` | The subscriber store file.                                                                                                                                        |
| `PULSE_NOTIFY_SUBSCRIPTIONS_MAX`                | `10000`                                               | 1 to 100000: the most subscriptions, pending and confirmed.                                                                                                       |
| `PULSE_NOTIFY_SUBSCRIPTIONS_MAX_PENDING`        | `1000`                                                | 1 to 100000 and at most `PULSE_NOTIFY_SUBSCRIPTIONS_MAX`. So `PULSE_NOTIFY_SUBSCRIPTIONS_MAX=5` also needs `PULSE_NOTIFY_SUBSCRIPTIONS_MAX_PENDING` of 5 or less. |
| `PULSE_NOTIFY_SUBSCRIPTIONS_CONFIRM_PER_HOUR`   | `100`                                                 | 1 to 10000: the most confirmation mails queued in any hour.                                                                                                       |
- A bad value stops startup with exit code 2 and one line that names the variable, never its value or a file's content. Every setting is checked before any file is opened.
- A subscriber send attempt has the timeout `min(PULSE_NOTIFY_TIMEOUT_MS, 60000)`.
- Email subscriptions need the status page at the root of its origin, for example `https://status.example.com`. A path such as `/pulse` is refused at startup while subscriptions are on: `PULSE_NOTIFY_SUBSCRIPTIONS_STATUS_URL: must be an origin without a path (root hosting)`.

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

| Key                  | Required | Meaning                                                                                                                                                      |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                 | yes      | Non-empty string, unique in the file. The delivery ledger is keyed by it.                                                                                    |
| `type`               | yes      | `webhook`, `file`, `slack`, `teams` or `email`                                                                                                               |
| `checks`             | no       | Check ids or `*` globs. Absent or empty means all checks. Unknown ids are allowed and match nothing.                                                         |
| `excludeChecks`      | no       | Check ids or `*` globs to skip. Wins over `checks`. See [routing](channels.md#routing).                                                                      |
| `components`         | no       | Component ids for manual incidents. Absent or empty means all. See [manual incidents](channels.md#manual-incidents).                                         |
| `excludeComponents`  | no       | Component ids whose manual incidents are skipped. Wins over `components`.                                                                                    |
| `remindEverySeconds` | no       | Integer of at least 60. Sends a `reminder` while an incident is open. See [reminders](channels.md#reminders).                                                |
| `alerts`             | no       | Array of `"budget-low"`, `"tls-expiry"`, `"domain-expiry"`. Absent or empty means no warnings; duplicates are ignored. See [warnings](channels.md#warnings). |
| `sendIncidents`      | no       | `true` (default) or `false`.`false` needs a non-empty `alerts` and no `remindEverySeconds`; the channel then gets only warnings.                             |

Per type:

| Type             | Key                          | Required | Meaning                                                                                                                                                |
| ---------------- | ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `webhook`        | `url` / `urlEnv` / `urlFile` | one of   | A valid `http:` or `https:` URL, inline or read from an env variable or a file. `http:` to a remote host logs a warning.                               |
| `webhook`        | `secretEnv` / `secretFile`   | no       | Signing secret, see [webhook.md](channels/webhook.md#signing)                                                                                          |
| `file`           | `path`                       | yes      | Non-empty file path. The parent directory is created.                                                                                                  |
| `slack`, `teams` | `urlEnv` / `urlFile`         | one of   | Where the `https:` webhook URL is read from; `statusUrl`, `hideReason` are optional. See [slack.md](channels/slack.md), [teams.md](channels/teams.md). |
| `email`          | `smtp`, `from`, `to`         | yes      | See [email.md](channels/email.md).`subjectPrefix`, `statusUrl`, `hideReason` are optional.                                                             |

Unknown keys are rejected at startup, for example `notify.json: unknown key "check" in channels[0]`. Check the spelling of `checks`. The place is a path, so an unknown key inside the SMTP block reads `notify.json: unknown key "extra" in channels[0].smtp`. Details of each channel are in [channels.md](channels.md).

Secrets and credential URLs (Slack, Teams, SMTP password, webhook signing secret) are read from environment variables or files, see [secrets](channels.md#secrets). Relative secret file paths are relative to the working directory. Do not put secrets in a webhook `url`: the config file holds it in clear text. pulse-notify does not log URLs.

Config errors for the new keys have fixed texts and never repeat the value: `channel "<id>": alerts must be an array of "budget-low", "tls-expiry" or "domain-expiry"`, `channel "<id>": sendIncidents must be true or false`, `channel "<id>": sendIncidents false needs alerts` and `channel "<id>": remindEverySeconds needs sendIncidents`.

An invalid config stops startup with `pulse-notify: <message>` and exit code 2. The messages are listed in [troubleshooting.md](troubleshooting.md).
