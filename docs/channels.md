# Channels

A channel is a place where notifications go. Each entry in `channels` of the config file is one channel. Keys are in [configuration.md](configuration.md#channel-config-file).

## What triggers a notification

pulse-notify polls `GET /incidents` and `GET /checks` of pulse-api in parallel on every tick. For each channel it looks at the incidents of the channel's checks:

- An incident that has not been handled yet gives an `opened` event.
- A resolved incident (`resolvedAt` is set) gives a `resolved` event.
- A resolved incident whose `opened` was never recorded gives `opened` first, then `resolved`.
- With `remindEverySeconds`, an open incident also gives `reminder` events, see [Reminders](#reminders).

Incidents of heartbeat checks (cron jobs and workers that ping pulse-api) are delivered like all others.

The key of an automatic `opened` or `resolved` event is `<incidentId>:<event>`, for example `12:opened`. Reminders and manual incidents use other forms, see [Reminders](#reminders) and [Manual incidents](#manual-incidents). Treat every key as an opaque string. When an incident opens is decided by pulse-api, see [quorum and incidents](https://github.com/lorenzh/pulse-api/blob/main/docs/concepts.md#quorum-and-incidents).

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

| Field        | Meaning                                                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`        | Opaque event key, unique per channel: `<incidentId>:opened`, `<incidentId>:resolved`, `<incidentId>:reminder:<n>`, `manual:<id>:opened`, `manual:<id>:update:<d>` or `manual:<id>:resolved`. Do not parse it. |
| `event`      | `opened`, `resolved` or `reminder`                                                                                                                                                                            |
| `incidentId` | Incident id in pulse-api                                                                                                                                                                                      |
| `checkId`    | Check id                                                                                                                                                                                                      |
| `checkName`  | Name from `GET /checks`. If the check is unknown there, the check id.                                                                                                                                         |
| `reason`     | The incident's opening reason, or `null` if it has none                                                                                                                                                       |
| `time`       | ISO 8601 UTC time of the event: `openedAt`, `resolvedAt`, or the send time of a reminder                                                                                                                      |
| `timeMs`     | The same time in epoch milliseconds                                                                                                                                                                           |
| `openedMs`   | Epoch milliseconds when the incident opened                                                                                                                                                                   |

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
- Changing the filters sends no burst. The ledger stores each channel's filters (`checks` and `excludeChecks`; `components` and `excludeComponents` for manual incidents), sorted and without duplicates, so order, duplicates and an empty list against an absent one do not count as a change. When the filters differ from the stored ones at a poll, the incidents that the API shows and that only the new filters route are recorded as `seeded`, together with their due reminder. Nothing is sent for them; the log says `routing changed: history of newly routed checks skipped` (or `... manual incidents skipped`). Their later events (`resolved`, a manual update, a reminder of a later interval) are sent. Incidents that both filters route are not touched, so events that happened while notify was stopped are still sent. Narrowing a filter only stores the new filters.
- The check filters are compared only when `/incidents` answered, and the component filters only when `/manual-incidents` answered (not on a 404). If the write fails, the channel's detection for that feed is skipped for that poll and the next poll tries again.
- Known limit: a ledger without stored filters (a JSON ledger migrated at upgrade, or a channel from an older version) takes the current filters as they are and seeds nothing. A filter widening made in the same restart as the upgrade can therefore send old history once. Upgrade first, then change the filters in a later restart.

## Manual incidents

Notify also reads `GET /manual-incidents` and announces each manual incident: one `opened` event when it is created (key `manual:<id>:opened`), one `update` event per later update (`manual:<id>:update:<d>`, `d` is the first 32 hex characters of SHA-256 over `JSON.stringify([at, status, message])` of the update; older versions used the index `<n>`) and one `resolved` event (`manual:<id>:resolved`). An update that resolves the incident gives only `resolved`. Each key is delivered once per channel, at least once, through the ledger. Deleting an incident cannot retract a message that was sent. Because the key depends on the update's content, inserting or reordering updates sends only the new ones. The wire format has no update id, so two updates of one incident with the same `at`, `status` and `message` count as one and are sent once; changing the message or status makes a new update.

- Routing uses component ids, not check ids. `components`: include list (absent or empty means no filter). `excludeComponents`: exclude list, it wins. Unknown ids are allowed and match nothing.
- `checks` and `excludeChecks` are ignored for manual incidents.
- An incident without components matches every channel except one with a `components` include list.
- The payload has `incidentId` (the manual id), `checkName` (the title), an empty `checkId` and `reason: null`, plus `manual`: `{ impact, status, message, componentIds }`. `message` is the text of the update the event is about. `time` is the update time.
- Chat and email messages show title, impact, status, the message and the component ids; control characters are cleaned and chat markup is escaped.
- On the first start of a channel, existing manual incidents are recorded without sending.
- Only public, published incidents are sent. An item with `visibility` other than `"public"` (an internal-only incident) or with `publishedAt` that is not a number (a draft) is dropped on read, before validation, seeding and routing. Notes and a pending draft update of a public incident are removed before detection. So no channel, also not a catch-all one, ever gets a draft, a note or an internal incident; there is no setting to opt in. A draft that is published later is announced once as a new incident. Older apis send neither field, so their items count as public. This needs pulse-contract `2.1.0`.
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
| `webhook`        | `url`, `urlEnv` or `urlFile`              | The URL            |

Exactly one of each pair, and exactly one of the three webhook URL keys. The `...Env` key holds the name of an environment variable; the `...File` key holds a path. A file is read once at start and one trailing newline is removed. A missing or empty variable or file stops startup with an error that names the channel and the key, never the value. Logs, errors and `/metrics` do not contain these values.

## Warnings

Besides incidents, a channel can get three warning events. It opts in with `alerts`, a list of `"budget-low"`, `"tls-expiry"` and `"domain-expiry"`. Absent or empty means no warnings. With `sendIncidents: false` the channel gets only warnings.

- `budget-low`: the error budget of an SLO (`slo.budgetRemaining` of `GET /checks` or `GET /components`) is strictly below the threshold (default 25). The comparison uses the unrounded value; `null` and a subject without `slo` never warn. A low SLO gets at most one event per 24 elapsed hours (not per calendar day). A recovery and a new drop inside that time send nothing, and days missed while notify was down give one event. A check and a component with the same id are two SLOs. There is no recovery event.
- `tls-expiry` and `domain-expiry`: the days left (`certDaysLeft` of a `tls` or `domain` check) reach a milestone. The first reading in `4..14` sends milestone 14, the first in `0..3` sends milestone 3. A first reading of 3 or less sends only milestone 3. Expired values (below 0) send nothing. Only a reading above 14 days rearms the check for a new episode. A reading is used only when it is fresh (at most `2 × intervalMs + 60 s` old) and newer than every reading used before, also across a restart.

Keys: `budget:check:<eventMs>:<h>`, `budget:component:<eventMs>:<h>` and `expiry:<episodeMs>:<milestone>:<h>`, where `<h>` is the first 32 hex characters of the SHA-256 of the subject id. Treat them as opaque.

Routing: a check warning follows `checks` and `excludeChecks`; a component warning follows `components` and `excludeComponents`, and is never expanded to the member checks. `sendIncidents` does not affect warnings.

Payload (webhook body and file line):

```json
{
  "key": "budget:check:1767268800000:<32 hex>",
  "event": "budget-low",
  "time": "2026-01-01T12:00:00.000Z",
  "timeMs": 1767268800000,
  "subject": { "kind": "check", "id": "api-health", "name": "API health" },
  "budget": {
    "remaining": 18.4,
    "threshold": 25,
    "target": 99.9,
    "availability": 99.8816,
    "windowDays": 30
  }
}
```

```json
{
  "key": "expiry:1767268800000:14:<32 hex>",
  "event": "tls-expiry",
  "time": "2026-01-01T12:00:05.000Z",
  "timeMs": 1767268805000,
  "subject": { "kind": "check", "id": "site-tls", "name": "Site TLS" },
  "expiry": { "daysLeft": 13, "milestone": 14, "observedMs": 1767268800000 }
}
```

`time` is the poll time of the event. `subject.kind` is `component` only for `budget-low`. `budget` holds the raw api values (not rounded) and the threshold in force.

Evaluation runs in each poll after the incident processing. Budget of checks needs a good `/checks` read; budget of components needs `/components`, which is read only when a channel has `budget-low` (a 404, an older api, means no components). Expiry needs `/checks`. A kind is skipped for the whole poll while any channel that subscribes to it is not yet in the ledger, so a new channel is seeded first. All alert changes of one poll and the `pending` entries of the routed channels are one ledger transaction; the deliveries start only after it committed. A failed write logs `alert state write failed, the next poll retries` and changes nothing. An event with no routed channel still advances the alert state.

A channel with `sendIncidents: false` sends no incident event. At start, before anything is sent, its pending incident entries (also held reminders and legacy keys) are set to `dropped` in one transaction and logged as `incident notifications dropped: channel sends no incidents` with `channel` and `count`. If that transaction fails, startup fails with `cannot drop pending incident notifications of channels with sendIncidents false` and the ledger is unchanged. Each poll records the incident keys that it would send as `seeded`, so switching back to `sendIncidents: true` sends only events that are new after that start. A failed seed logs `incident seed failed, the next poll retries`. Pending warnings stay and are resent; `failed` incident entries stay as a record, and a `failed resend` of one is dropped at the next start.

Known limits:

- Incidents of a warning-only channel that were pending at the switch are dropped, not sent.
- A renewal that keeps the days left at 14 or below (for example a new certificate valid for 10 days) is not seen; that episode gets no new warnings.
- A channel that subscribes later, or whose filters widen, gets the next event that becomes due, not past ones.
- A warning can be up to `2 × intervalMs` late, because notify reads the newest result of the check.

## Message content

Slack, Teams and email show: the check name, the state (`DOWN`, `RESOLVED`, `STILL DOWN`), the reason, the time in UTC, for reminders how long the incident has been open, and a link to your status page. Per channel:

- `statusUrl`: an `http(s)` URL shown as the link. Without it there is no link.
- `hideReason: true`: leaves the reason out (it may hold internal details). It does not change the webhook or file payload.

Warnings show the label `BUDGET LOW`, `TLS EXPIRES SOON` or `DOMAIN EXPIRES SOON`, the subject name, the time and the link. Budget warnings add `Error budget left: <r>% (alert below <t>%)` and `Availability: <a>% (target <target>%, 30 days)`; `<r>` is rounded down to 0.1 and `<a>` to 0.001 (`24.96` shows `24.9`, `-3.25` shows `-3.3`), or `no data`. Expiry warnings add `Expires in: <n> days` (`1 day`, `less than 1 day` for 0) and `Kind: TLS certificate` or `Kind: domain registration`. `hideReason` does not apply to warnings.

The reason is untrusted text: it is cut to 300 characters, control characters are removed, and it is escaped for the target format.

## Delivery and retries

- At least once per event and channel. This holds while the process runs, within the retry schedule below, and across restarts for unfinished (`pending`) events. Before the first send, `(channel, key)` is recorded as `pending` in the ledger together with the notification, then `delivered` or `failed`.
- Duplicates are possible: a retry, a crash after a send, or a failed ledger write can deliver an event twice. Receivers must deduplicate by the exact value of the `idempotency-key` header (the payload `key`). Treat it as an opaque string and do not parse it; its form differs by event, see [Payload](#payload).
- Retry schedule: the delay before retry n is `min(initial * 2^(n-1), max)`, without jitter. The initial delay is `PULSE_NOTIFY_RETRY_DELAY_MS` (default 1000 ms), the cap is `PULSE_NOTIFY_RETRY_MAX_DELAY_MS` (default 60000 ms), and `PULSE_NOTIFY_RETRY_ATTEMPTS` (default 12) is the total number of attempts per event. With the defaults:

  | Retry | 1   | 2   | 3   | 4   | 5    | 6    | 7-11 |
  | ----- | --- | --- | --- | --- | ---- | ---- | ---- |
  | Delay | 1 s | 2 s | 4 s | 8 s | 16 s | 32 s | 60 s |

  That is about 6 minutes in total. `PULSE_NOTIFY_RETRY_ATTEMPTS=0` retries without end.
- Permanent errors are not retried: the event is `failed` after the first attempt, with no delay and also with `PULSE_NOTIFY_RETRY_ATTEMPTS=0`, and the log line `notification delivery failed` has `permanent: true`. They are:
  - HTTP channels (webhook, Slack, Teams): a 4xx status except 408 and 429, for example 400, 401, 403, 404 or 410. A 3xx status, 408, 429, a 5xx status, a timeout or a network error is retried.
  - Email: an SMTP reply with a 5xx code, at any stage. A 4xx reply is retried.

  The next queued event of the channel is sent at once. Resend a failed event with `failed resend`, see [operation.md](operation.md#failed-events-and-resend).
- `PULSE_NOTIFY_RETRY_ATTEMPTS=0` keeps retrying a failing event without end, but it does not block the channel: later events of that channel are still sent.
- After the last attempt the event is logged at error level (channel, key, attempts, error, code, cause) and marked `failed`. `failed` is not retried by the service, not even after a restart (unless `PULSE_NOTIFY_RETRY_ATTEMPTS=0`, where a retryable error never ends the event). Its notification is kept in the ledger, so `failed resend` can send it again.
- Each channel has its own queue and sends one event at a time. A slow or failing channel delays neither other channels nor polling. First attempts run in the order the events arrive. When an attempt fails and a retry follows, the event waits for its own retry delay without blocking the channel; the next event is sent at once. When the delay ends, the event goes to the end of the queue, behind the events that are already waiting to be sent. So completion order is not FIFO: a retried event can arrive after events that came later, for example a `resolved` before its `opened`. Each event counts its own attempts. A reminder is checked again before each attempt and is dropped if its incident resolved during the wait.
- `resolved` is sent after `opened`. It is still sent if `opened` failed.
- On the first start of a channel (new ledger or new channel id) all incidents that the API shows are recorded as `seeded`. No notifications are sent for this history. The seed covers all incidents, whatever the `checks` filter says.
- A failing or malformed api poll is logged and retried on the next tick. See [operation.md](operation.md) for restarts and logs.

## Database channels

With a service token, the api may hold channels of type `webhook`, `slack`, `teams` and `email` (never `file`). They hold references only, never a secret value:

- An env reference must match `PULSE_NOTIFY_SECRET_[A-Z0-9_]{1,64}`; other variables, such as `PULSE_NOTIFY_API_TOKEN`, are never read for them.
- A file reference is a basename (`[A-Za-z0-9][A-Za-z0-9._-]{0,127}`), read only inside `PULSE_NOTIFY_SECRET_DIR`. A symlink that leads out of that directory is refused. Without the variable, file references are refused with `secret files are not enabled`.
- The channels answer is checked in two levels. A bad envelope (not `{revision, channels}`, more than 100 channels, a missing, invalid or repeated id) is refused as a whole and nothing changes. After a good envelope each channel is checked on its own, including the limit of 16384 bytes of JSON per definition; a bad channel is reported by its id and the others still apply.
- A channel file entry with the same id wins over the database channel as a whole; no field is mixed. The database copy is listed in `shadowedIds` of the report, and removing the file entry installs it again.
- Every `PULSE_NOTIFY_CHANNELS_POLL_MS` notify re-reads the channel file (applied only when its SHA-256 changes, also without a token) and asks for the channels with the stored ETag. An invalid, deleted or unreadable file keeps the last good file channels and is reported as a rejection with `channelId: null` until the file is good again. A refused envelope, an answer over 1048576 bytes, a wire mismatch, invalid JSON, or a failed read (api error status other than 404, network error, timeout) keeps everything: workers, stored rows, ETag and applied revision; the report shows one rejection with `channelId: null` and a reason that starts with `channels answer`. Without a token notify ignores stored database channels from an earlier run. After a good envelope a bad or unresolvable channel keeps its last good version, and the rejection stays until a later answer fixes it.
- A changed channel gets a new worker: the old one finishes its send in flight, then hands its pending events and email recipient progress to the new one. An unchanged channel keeps its worker. A removed channel keeps its pending events until it returns. A new channel is seeded quietly.
- The last applied definitions (references only) are stored in the state file, so they work after a restart while the api is down. An api that answers 404 gives no database channels, logged once.
- After every poll, and at least every 60000 ms, notify sends `PUT /service/notify/report`: the applied revision, the file channels with their reference names, the shadowed ids, the rejections and the newest failed events, without payloads or destinations. Without a token notify makes no `/service/*` call and sends no report.
