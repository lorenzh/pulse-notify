# Channels

A channel is a place where notifications go. Each entry in `channels` of the config file is one channel. Keys are in [configuration.md](configuration.md#channel-config-file).

## What triggers a notification

pulse-notify polls `GET /incidents` and `GET /checks` of pulse-api in parallel on every tick. For each channel it looks at the incidents of the channel's checks:

- An incident that has not been handled yet gives an `opened` event.
- A resolved incident (`resolvedAt` is set) gives a `resolved` event.
- A resolved incident whose `opened` was never recorded gives `opened` first, then `resolved`.

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
  "timeMs": 1767268800000
}
```

| Field        | Meaning                                                                           |
| ------------ | --------------------------------------------------------------------------------- |
| `key`        | `<incidentId>:<event>`. Unique per channel.                                       |
| `event`      | `opened` or `resolved`                                                            |
| `incidentId` | Incident id in pulse-api                                                          |
| `checkId`    | Check id                                                                          |
| `checkName`  | Name from `GET /checks`. If the check is unknown there, the check id.             |
| `reason`     | The incident's opening reason, or `null` if it has none                           |
| `time`       | ISO 8601 UTC time of the event: `openedAt` or `resolvedAt`, not the delivery time |
| `timeMs`     | The same time in epoch milliseconds                                               |

The types `Incident` and `Check` come from [pulse-contract](https://github.com/lorenzh/pulse-contract/blob/main/docs/index.md).

## `webhook`

```json
{ "id": "ops-hook", "type": "webhook", "url": "https://example.com/hook" }
```

- Sends a `POST` to `url` with the payload as body.
- Headers: `content-type: application/json` and `idempotency-key: <key>`, in the form `<incident id>:<event>`. Delivery is at least once, so use the key to drop duplicates on your side.
- A 2xx status is success. Any other status is a failure. Redirects are not followed, so a 3xx is a failure.
- Each attempt times out after `PULSE_NOTIFY_TIMEOUT_MS` (default 5000 ms). The error is `timeout after <ms>ms`. A failed status gives `webhook responded with status <code>`.

## `file`

```json
{ "id": "log", "type": "file", "path": "./incidents.jsonl" }
```

In Docker, only `/data` is writable. Use this config there:

```json
{ "id": "log", "type": "file", "path": "/data/incidents.jsonl" }
```

- Appends the payload as one JSON line to `path`. The parent directory is created if it is missing.
- The file is never truncated or rotated by pulse-notify.
- A write error (for example a permission error) is a failed attempt and is retried like any other.
- In Docker, use a path under a mounted writable directory, for example `/data/incidents.jsonl`.

## Delivery and retries

- At least once. Before the first send, `(channel, key)` is recorded as `pending` in the ledger, then `delivered` or `failed`. A retry can deliver an event twice, so receivers must deduplicate by the key. The key is `<incident id>:<event>` (for example `12:opened`), sent as the `idempotency-key` header.
- Each event gets 4 attempts: the first and 3 retries. The wait between attempts is `PULSE_NOTIFY_RETRY_DELAY_MS` (default 1000 ms).
- After the fourth failure the event is logged at error level (channel, key, attempts, last error), marked `failed` and never retried, not even after a restart.
- Each channel has its own FIFO queue and worker. A slow or failing channel delays neither other channels nor polling.
- `resolved` is sent after `opened`. It is still sent if `opened` failed.
- On the first start of a channel (new ledger or new channel id) all incidents that the API shows are recorded as `seeded`. No notifications are sent for this history. The seed covers all incidents, whatever the `checks` filter says.
- A failing api poll is logged and retried on the next tick. See [operation.md](operation.md) for restarts and logs.
