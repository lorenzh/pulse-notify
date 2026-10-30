# Channels

A channel is a place where notifications go. Each entry in `channels` of the config file is one channel. Keys are in [configuration.md](configuration.md#channel-config-file).

## What triggers a notification

pulse-notify polls `GET /incidents` and `GET /checks` of pulse-api in parallel on every tick. For each channel it looks at the incidents of the channel's checks:

- An incident that has not been handled yet gives an `opened` event.
- A resolved incident (`resolvedAt` is set) gives a `resolved` event.
- A resolved incident whose `opened` was never recorded gives `opened` first, then `resolved`.
- With `remindEverySeconds`, an open incident also gives `reminder` events, see [Reminders](#reminders).

Incidents of heartbeat checks (cron jobs and workers that ping pulse-api) are delivered like all others.

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

## Manual incidents

Notify also reads `GET /manual-incidents` and announces each manual incident: one `opened` event when it is created (key `manual:<id>:opened`), one `update` event per later update (`manual:<id>:update:<n>`, `n` is the update's index) and one `resolved` event (`manual:<id>:resolved`). An update that resolves the incident gives only `resolved`. Each key is delivered once per channel, at least once, through the ledger. Deleting an incident cannot retract a message that was sent.

- Routing uses component ids, not check ids. `components`: include list (absent or empty means no filter). `excludeComponents`: exclude list, it wins. Unknown ids are allowed and match nothing.
- `checks` and `excludeChecks` are ignored for manual incidents.
- An incident without components matches every channel except one with a `components` include list.
- The payload has `incidentId` (the manual id), `checkName` (the title), an empty `checkId` and `reason: null`, plus `manual`: `{ impact, status, message, componentIds }`. `message` is the text of the update the event is about. `time` is the update time.
- Chat and email messages show title, impact, status, the message and the component ids; control characters are cleaned and chat markup is escaped.
- On the first start of a channel, existing manual incidents are recorded without sending.
- An api that answers 404 for `/manual-incidents` (older version) counts as having none. Other failures fail the poll, but automatic incidents are still delivered; see [operation.md](operation.md#failing-feeds).

## Reminders

Set `remindEverySeconds` (an integer of at least 60) on a channel to get a "still down" message while an incident stays open. It works for every channel type.

- The event is `reminder`, the key is `<incidentId>:reminder:<n>` with `n = floor((now - openedAt) / interval)`. The first reminder comes one interval after the incident opened.
- `time` and `timeMs` are the reminder time. `openedMs` gives the incident's start, so the age is `timeMs - openedMs`. Chat and email messages show it as `Open for`. Whole hours read `1h`, not `1h 0m`; whole days read `1d`, not `1d 0h` (`formatDuration` of pulse-kit).
- After a restart, a pending reminder is held until the first successful poll, then dropped if its incident resolved or a newer reminder exists. A reminder is superseded by a newer one of the same incident that is queued or in the ledger with any status except `dropped`. Nothing is repeated, because `n` is derived from the clock and the ledger holds the key.
- After an outage of pulse-notify or the channel only the latest due reminder is sent, not one for every missed interval.
- A new channel starts with the current `n`: reminders for incidents that are already open begin at the next interval.
- Switching `remindEverySeconds` on for an existing channel does the same: at the first poll the due reminder of every open incident is recorded as `seeded` and nothing is sent, so there is no burst. The ledger stores the time as `remindersFrom` for the channel. Later incidents and later intervals remind normally. Removing `remindEverySeconds` drops `remindersFrom`, so switching it on again seeds again. Known limit: after an upgrade from a version 1 ledger, one due reminder per open incident is skipped once.
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
- Permanent errors are not retried: the event is `failed` after the first attempt, with no delay and also with `PULSE_NOTIFY_RETRY_ATTEMPTS=0`, and the log line `notification delivery failed` has `permanent: true`. They are:
  - HTTP channels (webhook, Slack, Teams): a 4xx status except 408 and 429, for example 400, 401, 403, 404 or 410. A 3xx status, 408, 429, a 5xx status, a timeout or a network error is retried.
  - Email: an SMTP reply with a 5xx code, at any stage. A 4xx reply is retried.

  The next queued event of the channel is sent at once. Resend a failed event with `failed resend`, see [operation.md](operation.md#failed-events-and-resend).
- `PULSE_NOTIFY_RETRY_ATTEMPTS=0` caveat: a retryable error (for example a 503 or a dead host) then blocks the channel until the receiver recovers, because there is no deadline per event. Later events of that channel wait behind it. Use a finite number unless blocking is what you want.
- After the last attempt the event is logged at error level (channel, key, attempts, error, code, cause) and marked `failed`. `failed` is not retried by the service, not even after a restart (unless `PULSE_NOTIFY_RETRY_ATTEMPTS=0`, where a retryable error never ends the event). Its notification is kept in the ledger, so `failed resend` can send it again.
- Each channel has its own FIFO queue and worker. A slow or failing channel delays neither other channels nor polling. Within one channel the order is kept, so a long retry blocks the later events of that channel (head-of-line blocking, up to the whole schedule).
- `resolved` is sent after `opened`. It is still sent if `opened` failed.
- On the first start of a channel (new ledger or new channel id) all incidents that the API shows are recorded as `seeded`. No notifications are sent for this history. The seed covers all incidents, whatever the `checks` filter says.
- A failing or malformed api poll is logged and retried on the next tick. See [operation.md](operation.md) for restarts and logs.
