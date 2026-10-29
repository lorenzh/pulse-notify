# Operation

## State: the delivery ledger

pulse-notify keeps one state file, the delivery ledger. Its path is `PULSE_NOTIFY_STATE` (default `./notify-state.json`; `/data/notify-state.json` in the Docker image).

- One JSON object: `{ "version": 1, "channels": { "<channel id>": { "<key>": "<status>" } }, "payloads": { "<channel id>": { "<key>": <notification> } } }`. `payloads` is optional and holds the notification of each `pending` key only, so it stays small. A file without it loads as before.
- Status is `seeded`, `pending`, `delivered` or `failed`.
- The file is rewritten on every change: written to `<path>.tmp`, flushed to disk, then renamed over the ledger. The parent directory is created if missing.
- The ledger is read once at start. Do not edit it while pulse-notify runs.
- A file with a different `version` or no `channels` object stops the process, see [troubleshooting.md](troubleshooting.md).
- The ledger grows by one entry per channel and event. pulse-notify never prunes it.

Backup: copy the file. It is replaced atomically, so a copy is always a whole file. Restoring is putting the file back with pulse-notify stopped. This was not tested as a procedure beyond that.

If you delete the ledger, every channel counts as new on the next start. It records the current incidents as `seeded` and sends nothing for them. If you remove a channel id and add it back later, it is not seeded again: the ledger keeps the channel. The re-added channel receives the incidents from the time it was removed.

## Restart behavior

- The environment and the config file are read at start. To change a channel, a URL or a setting, restart.
- At start, every `pending` ledger entry that has a stored notification is sent again, oldest first, before the first poll. One `info` line `resending pending notifications` per channel gives the `count`. This only applies to channels that are already in the ledger.
- A `pending` entry written by an older version has no stored notification. The poll rebuilds it from the API incident (key `<id>:<event>`) and sends it. If the incident is no longer returned, `pending notification cannot be rebuilt: incident not found` is logged once per start and the key stays `pending`.
- Events that failed all attempts stay `failed` and are not retried (unless `PULSE_NOTIFY_RETRY_ATTEMPTS=0`).
- `SIGINT` and `SIGTERM`: polling stops, sleeps and sends in flight are aborted, unfinished keys stay `pending` (so they are resent at the next start), and the process exits with 0 once the workers are done. It waits at most 5 seconds for that. A send that was in flight has an unknown result and is sent again, so a duplicate is possible.
- If pulse-api is down, stalls or sends malformed data, pulse-notify keeps running and polls again on the next tick. An incident with a bad `id`, `checkId`, `openedAt` or `resolvedAt` (including a timestamp outside the range of a JavaScript `Date`, ±8.64e15 ms) is skipped with an `error` log (`incident skipped: malformed data`, once per incident id and process). It creates no ledger entry and is checked again on every poll. Other incidents are still processed.
- Ledger write errors do not stop the process. A failed `claim` means the event is not sent and the next poll tries again. A failed `settle` after a send leaves the key `pending`, so it is sent again at the next start. A failed `seed` leaves the channel unseeded and the next poll tries again.

## Logs

Logs are JSON lines on stderr. Each line has `time` (ISO 8601 UTC), `level` (`info`, `warn` or `error`), `msg` and extra fields.

| Level   | `msg`                                                        | Fields                                                 |
| ------- | ------------------------------------------------------------ | ------------------------------------------------------ |
| `info`  | `pulse-notify started`                                       | `channels` (ids), `apiUrl`                             |
| `info`  | `channel seeded with existing incidents`                     | `channel`, `incidents`                                 |
| `info`  | `resending pending notifications`                            | `channel`, `count`                                     |
| `info`  | `notification delivered`                                     | `channel`, `key`, `attempts`                           |
| `warn`  | `delivery attempt failed`                                    | `channel`, `key`, `attempt`, `error`, `code`, `cause`  |
| `error` | `notification delivery failed`                               | `channel`, `key`, `attempts`, `error`, `code`, `cause` |
| `error` | `api poll failed`                                            | `error`, `code`, `cause`                               |
| `error` | `incident skipped: malformed data`                           | `incidentId`, `reason`                                 |
| `error` | `pending notification cannot be rebuilt: incident not found` | `channel`, `key`                                       |
| `error` | `ledger claim failed, the next poll retries`                 | `channel`, `key`, `error`                              |
| `error` | `ledger settle failed, the key stays pending`                | `channel`, `key`, `error`                              |
| `error` | `ledger seed failed, the next poll retries`                  | `channel`, `error`                                     |

`error` is the message of the error. `code` (for example `ECONNREFUSED`, `ENOTFOUND`, `CERT_HAS_EXPIRED`) and `cause` (the message of the innermost cause) appear when the error has them. `fetch failed` alone says little; `code` and `cause` say why.

Startup configuration errors are not JSON. They are one line on stderr: `configuration error: <message>`, exit code 2.
