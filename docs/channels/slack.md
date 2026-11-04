# Slack channel

Posts a message to a Slack incoming webhook.

```json
{
  "id": "slack-ops",
  "type": "slack",
  "urlEnv": "SLACK_WEBHOOK_URL",
  "statusUrl": "https://status.example.com",
  "hideReason": false,
  "remindEverySeconds": 3600
}
```

| Key                  | Required | Meaning                                                                                                   |
| -------------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `urlEnv` / `urlFile` | one of   | Name of an environment variable, or path of a file, that holds the webhook URL. There is no inline `url`. |
| `statusUrl`          | no       | `http(s)` link to your status page. It is shown in the message; absent means no link.                     |
| `hideReason`         | no       | `true` leaves the reason out of the message.                                                              |

Common keys (`checks`, `excludeChecks`, `remindEverySeconds`) are in [../channels.md](../channels.md#routing).

- The URL must be `https:`. `http:` is accepted only for `127.0.0.1` and `localhost` (tests). Anything else stops startup.
- The body is `{"text": "..."}` in Slack mrkdwn. `&`, `<` and `>` in the check name and reason are escaped, so `<!channel>` and user mentions in a reason stay plain text.
- Any 2xx status is success. 429, 5xx, redirects and network errors are failures that are retried like for webhooks. `Retry-After` is not used.
- Slack messages are not signed.

Sample message:

```text
*DOWN*: Example site
Reason: HTTP 503
Time: 2026-01-01T12:00:00.000Z
Status: https://status.example.com
```

A reminder reads `*STILL DOWN*` and adds `Open for: 1h 5m`. A resolution reads `*RESOLVED*`.

A warning (see [Warnings](../channels.md#warnings)):

```text
*BUDGET LOW*: API health
Error budget left: 18.4% (alert below 25%)
Availability: 99.881% (target 99.9%, 30 days)
Time: 2026-01-01T12:00:00.000Z
Status: https://status.example.com
```

An expiry warning reads `*TLS EXPIRES SOON*` or `*DOMAIN EXPIRES SOON*` with `Expires in: 13 days` and `Kind: TLS certificate` or `Kind: domain registration`. The name is escaped as for incidents.
