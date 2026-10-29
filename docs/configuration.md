# Configuration

pulse-notify reads environment variables and one JSON config file. Both are read once at start. Restart to apply a change.

## Environment variables

| Variable                      | Default                 | Meaning                                                     |
| ----------------------------- | ----------------------- | ----------------------------------------------------------- |
| `PULSE_NOTIFY_CONFIG`         | required                | Path to the channel config file                             |
| `PULSE_API_URL`               | `http://localhost:3000` | pulse-api base URL                                          |
| `PULSE_NOTIFY_STATE`          | `./notify-state.json`   | Delivery ledger file, see [operation.md](operation.md)      |
| `PULSE_NOTIFY_POLL_MS`        | `5000`                  | Poll interval in milliseconds, at least 1                   |
| `PULSE_NOTIFY_RETRY_DELAY_MS` | `1000`                  | Delay between delivery attempts in milliseconds, 0 or more  |
| `PULSE_NOTIFY_TIMEOUT_MS`     | `5000`                  | Timeout per webhook attempt and per api request, at least 1 |
- The numeric variables must be non-negative integers. Anything else stops startup with `<NAME> must be a non-negative integer`.
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

Other keys are ignored. Details of each channel are in [channels.md](channels.md).

Do not put secrets in a webhook URL if you share the config file or its logs. pulse-notify does not log the URL, but your config file holds it in clear text.

An invalid config stops startup with `configuration error: <message>`. The messages are listed in [troubleshooting.md](troubleshooting.md).
