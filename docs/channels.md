# Channels

A channel is a place where notifications go. Each entry in `channels` of the config file is one channel. Keys are in [configuration.md](configuration.md#channel-config-file).

## What triggers a notification

pulse-notify polls `GET /incidents` and `GET /checks` of pulse-api in parallel on every tick. For each channel it looks at the incidents of the channel's checks:

- An incident that has not been handled yet gives an `opened` event.
- A resolved incident (`resolvedAt` is set) gives a `resolved` event.
- A resolved incident whose `opened` was never recorded gives `opened` first, then `resolved`.
- With `remindEverySeconds`, an open incident also gives `reminder` events, see [Reminders](#reminders).

The event key is `<incidentId>:<event>`, for example `12:opened`. When an incident opens is decided by pulse-api, see [quorum and incidents](https://github.com/lorenzh/pulse-api/blob/main/docs/concepts.md#quorum-and-incidents).

## Payload

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
  "timeMs": 1767268800000,
  "openedMs": 1767268800000
}
```

| Field        | Meaning                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------- |
| `key`        | `<incidentId>:<event>`. Unique per channel.                                              |
| `event`      | `opened`, `resolved` or `reminder`                                                       |
| `incidentId` | Incident id in pulse-api                                                                 |
| `checkId`    | Check id                                                                                 |
| `checkName`  | Name from `GET /checks`. If the check is unknown there, the check id.                    |
| `reason`     | The incident's opening reason, or `null` if it has none                                  |
| `time`       | ISO 8601 UTC time of the event: `openedAt`, `resolvedAt`, or the send time of a reminder |
| `timeMs`     | The same time in epoch milliseconds                                                      |
| `openedMs`   | Epoch milliseconds when the incident opened                                              |

The types `Incident` and `Check` come from [pulse-contract](https://github.com/lorenzh/pulse-contract/blob/main/docs/index.md).

## Channel types

| Type      | Page                                       | Sends                                             |
| --------- | ------------------------------------------ | ------------------------------------------------- |
| `webhook` | [channels/webhook.md](channels/webhook.md) | The JSON payload, optionally signed with an HMAC  |
| `file`    | [channels/file.md](channels/file.md)       | The JSON payload as one line                      |
| `slack`   | [channels/slack.md](channels/slack.md)     | A text message to a Slack incoming webhook        |
| `teams`   | [channels/teams.md](channels/teams.md)     | An Adaptive Card to a Teams Workflows webhook URL |
| `email`   | [channels/email.md](channels/email.md)     | A plain text email over SMTP                      |

## Routing

Every channel can limit the checks it reports:

- `checks`: include list. Absent or empty means all checks.
- `excludeChecks`: exclude list. It wins over `checks`.
- An entry is an exact check id, or a glob where `*` matches any characters: `api-*` matches `api-eu` and `api-us`. An entry without `*` matches exactly, so old configs behave the same.
- Routing applies to all channel types and to reminders.
- There are no tags: pulse-contract has no tags on checks, so route by id or by pattern.

## Reminders

Set `remindEverySeconds` (an integer of at least 60) on a channel to get a "still down" message while an incident stays open. It works for every channel type.

- The event is `reminder`, the key is `<incidentId>:reminder:<n>` with `n = floor((now - openedAt) / interval)`. The first reminder comes one interval after the incident opened.
- `time` and `timeMs` are the reminder time. `openedMs` gives the incident's start, so the age is `timeMs - openedMs`. Chat and email messages show it as `Open for`.
- After a restart nothing is repeated, because `n` is derived from the clock and the ledger holds the key.
- After an outage of pulse-notify or the channel only the latest due reminder is sent, not one for every missed interval.
- A new channel starts with the current `n`: reminders for incidents that are already open begin at the next interval.
- A resolved incident gets no reminder. A reminder that is still queued or retrying when its incident resolves is dropped (the ledger marks it `dropped`), so `resolved` never follows a late reminder.
- Webhook and file receivers see `"event": "reminder"` only if you set `remindEverySeconds` on that channel. Make sure they accept the value.
- Older reminder keys of an incident are removed from the ledger when a newer one is recorded.

## Secrets

Credentials never go inline in the config file, except the webhook `url`:

| Channel          | Keys                                      | What               |
| ---------------- | ----------------------------------------- | ------------------ |
| `slack`, `teams` | `urlEnv` or `urlFile`                     | The webhook URL    |
| `email`          | `smtp.passwordEnv` or `smtp.passwordFile` | The SMTP password  |
| `webhook`        | `secretEnv` or `secretFile` (optional)    | The signing secret |

Exactly one of each pair. The `...Env` key holds the name of an environment variable; the `...File` key holds a path. A file is read once at start and one trailing newline is removed. A missing or empty variable or file stops startup with an error that names the channel and the key, never the value. Logs, errors and `/metrics` do not contain these values.

## Message content

Slack, Teams and email show: the check name, the state (`DOWN`, `RESOLVED`, `STILL DOWN`), the reason, the time in UTC, for reminders how long the incident has been open, and a link to your status page. Per channel:

- `statusUrl`: an `http(s)` URL shown as the link. Without it there is no link.
- `hideReason: true`: leaves the reason out (it may hold internal details). It does not change the webhook or file payload.

The reason is untrusted text: it is cut to 300 characters, control characters are removed, and it is escaped for the target format.

## Delivery and retries

- At least once per event and channel. This holds while the process runs, within the retry schedule below, and across restarts for unfinished (`pending`) events. Before the first send, `(channel, key)` is recorded as `pending` in the ledger together with the notification, then `delivered` or `failed`.
- Duplicates are possible: a retry, a crash after a send, or a failed ledger write can deliver an event twice. Receivers must deduplicate by the key `<incident id>:<event>` (for example `12:opened`), sent as the `idempotency-key` header.
- Retry schedule: the delay before retry n is `min(initial * 2^(n-1), max)`, without jitter. The initial delay is `PULSE_NOTIFY_RETRY_DELAY_MS` (default 1000 ms), the cap is `PULSE_NOTIFY_RETRY_MAX_DELAY_MS` (default 60000 ms), and `PULSE_NOTIFY_RETRY_ATTEMPTS` (default 12) is the total number of attempts per event. With the defaults:

  | Retry | 1   | 2   | 3   | 4   | 5    | 6    | 7-11 |
  | ----- | --- | --- | --- | --- | ---- | ---- | ---- |
  | Delay | 1 s | 2 s | 4 s | 8 s | 16 s | 32 s | 60 s |

  That is about 6 minutes in total. `PULSE_NOTIFY_RETRY_ATTEMPTS=0` retries without end.
- After the last attempt the event is logged at error level (channel, key, attempts, error, code, cause) and marked `failed`. `failed` is final: it is not retried, not even after a restart (unless `PULSE_NOTIFY_RETRY_ATTEMPTS=0`, where an event never fails).
- Each channel has its own FIFO queue and worker. A slow or failing channel delays neither other channels nor polling. Within one channel the order is kept, so a long retry blocks the later events of that channel (head-of-line blocking, up to the whole schedule).
- `resolved` is sent after `opened`. It is still sent if `opened` failed.
- On the first start of a channel (new ledger or new channel id) all incidents that the API shows are recorded as `seeded`. No notifications are sent for this history. The seed covers all incidents, whatever the `checks` filter says.
- A failing or malformed api poll is logged and retried on the next tick. See [operation.md](operation.md) for restarts and logs.
