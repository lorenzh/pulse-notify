# Configuration

pulse-notify reads environment variables and one JSON config file. Both are read once at start. Restart to apply a change.

## Environment variables

| Variable                          | Default                 | Meaning                                                                                             |
| --------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------- |
| `PULSE_NOTIFY_CONFIG`             | required                | Path to the channel config file                                                                     |
| `PULSE_API_URL`                   | `http://localhost:3000` | pulse-api base URL                                                                                  |
| `PULSE_NOTIFY_STATE`              | `./notify-state.json`   | Delivery ledger file, see [operation.md](operation.md)                                              |
| `PULSE_NOTIFY_POLL_MS`            | `5000`                  | Poll interval in milliseconds, at least 1                                                           |
| `PULSE_NOTIFY_RETRY_DELAY_MS`     | `1000`                  | Initial delay before the first retry in milliseconds; it doubles per retry                          |
| `PULSE_NOTIFY_RETRY_MAX_DELAY_MS` | `60000`                 | Cap of the delay between attempts, at least the initial delay                                       |
| `PULSE_NOTIFY_RETRY_ATTEMPTS`     | `12`                    | Total attempts per event; `0` retries without end                                                   |
| `PULSE_NOTIFY_TIMEOUT_MS`         | `5000`                  | Timeout per webhook attempt and per api request, at least 1. It covers reading the response body.   |
| `PULSE_LOG_LEVEL`                 | `info`                  | `debug`, `info`, `warn` or `error`. Another value stops startup.                                    |
| `PULSE_HEALTH_PORT`               | unset                   | Port of the health and metrics listener, see [operation.md](operation.md). Unset means no listener. |
| `PULSE_HEALTH_HOST`               | `127.0.0.1`             | Address of that listener. The Docker image sets `0.0.0.0` and port `9100`.                          |

The schedule is in [channels.md](channels.md#delivery-and-retries).

- The numeric variables must be non-negative integers. Anything else stops startup with `<NAME> must be a non-negative integer`.
- `PULSE_NOTIFY_RETRY_MAX_DELAY_MS` below `PULSE_NOTIFY_RETRY_DELAY_MS` stops startup with `PULSE_NOTIFY_RETRY_MAX_DELAY_MS must be at least PULSE_NOTIFY_RETRY_DELAY_MS`.
- An empty value counts as unset, so the default applies.
- Example: `PULSE_NOTIFY_POLL_MS=30000` polls every 30 seconds.

## Channel config file

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

| Key      | Required | Meaning                                                                                          |
| -------- | -------- | ------------------------------------------------------------------------------------------------ |
| `id`     | yes      | Non-empty string, unique in the file. The delivery ledger is keyed by it.                        |
| `type`   | yes      | `webhook` or `file`                                                                              |
| `checks` | no       | Array of check ids. Absent or empty means all checks. Unknown ids are allowed and match nothing. |

Per type:

| Type      | Key    | Required | Meaning                                               |
| --------- | ------ | -------- | ----------------------------------------------------- |
| `webhook` | `url`  | yes      | A valid `http:` or `https:` URL                       |
| `file`    | `path` | yes      | Non-empty file path. The parent directory is created. |

Unknown keys are rejected at startup, for example `notify.json: unknown key "check" in channels[0]`. Check the spelling of `checks`. Details of each channel are in [channels.md](channels.md).

Do not put secrets in a webhook URL if you share the config file or its logs. pulse-notify does not log the URL, but your config file holds it in clear text.

An invalid config stops startup with `pulse-notify: <message>` and exit code 2. The messages are listed in [troubleshooting.md](troubleshooting.md).
