# Operation

## State: the delivery ledger

pulse-notify keeps one state file, the delivery ledger. Its path is `PULSE_NOTIFY_STATE` (default `./notify-state.json`; `/data/notify-state.json` in the Docker image).

- One JSON object, format version 2: `{ "version": 2, "channels": { "<channel id>": { "<key>": { "status": "<status>", "at": <epoch ms> } } }, "payloads": { "<channel id>": { "<key>": <notification> } }, "remindersFrom": { "<channel id>": <epoch ms> } }`. `at` is the time of the last status change. `payloads` holds the notification of each `pending` and `failed` key, so a failed event can be resent. `remindersFrom` is set only for channels with `remindEverySeconds`.
- A version 1 file (a plain status string per key) loads and is migrated in memory: each entry gets the load time as `at`. Every write is version 2. A file with a newer version, or no `channels` object, stops the process, see [troubleshooting.md](troubleshooting.md).
- Status is `seeded`, `pending`, `delivered`, `failed` or `dropped`.
- Durability: `seed`, `claim` (before the first send) and `resend` are written at once, flushed to disk, then renamed over the ledger. `settle` (delivered, failed, dropped) and pruning are batched: the change is kept in memory and written about 100 ms later in one write (temporary file, flush, rename), and at shutdown. A crash can lose a settle; the key is then still `pending` and is sent again at the next start (at-least-once). The parent directory is created if missing.
- The ledger is read once at start. Do not edit it while pulse-notify runs.
- Retention: at the first poll and then once per hour, entries with status `delivered`, `dropped`, `failed` or `seeded` that are older than `PULSE_NOTIFY_STATE_RETENTION_DAYS` (default 30) are removed with their payloads. `pending` entries are never pruned. A key of an incident that the last successful poll still lists is kept, however old, because without it the event would look unhandled and be sent again. This means pulse-api must keep an incident at least as long as the retention, or the key of an incident that is still listed could be pruned: the guard covers that case, but keep the two settings in line. Before the first successful poll no incident key is pruned.

### State file lock

Only one process may use a state file. At start pulse-notify creates `<state file>.lock` (exclusive create) with `{ "pid", "hostname", "token", "heartbeat" }`. The holder rewrites `heartbeat` every `PULSE_NOTIFY_LOCK_LEASE_SECONDS / 6` seconds (10 s with the default 60) and removes the file on a clean stop. An existing lock is judged in this order:

1. Unreadable or corrupt content counts as live: startup stops with exit code 2. pulse-notify never guesses.
2. Same host name as this process: stale if the pid is not running, or if the pid is this process's own pid (a restarted Docker container keeps its host name and pid 1, and a new process cannot be its own predecessor). Another running pid on this host is live.
3. Another host name: never judged by pid, since another host's pid cannot be checked and two containers on one volume have different host names. The lock is live while `now - heartbeat` is below the lease and stale after it. The time comes from the lock file written by the holder; hosts that share the volume need clocks that agree within a small part of the lease.

A live lock stops startup with exit code 2: `state file <path> is in use by <host> pid <n> (heartbeat <s>s ago; remove <path>.lock if no pulse-notify runs)`. The parent directory of the state file is created before the lock; an unusable path stops startup with exit code 2 and one line `cannot use state file <path>: <reason>`. A stale lock is taken over with a `warn` line `taking over a stale state lock`. The takeover is serialised by the marker file `<state file>.lock.takeover` (created exclusively, removed when the takeover ends): a contender that finds a live marker exits 2. A marker left by a crashed takeover clears itself once it is older than 10 s or, on the same host, when its pid is dead; an unreadable marker is never guessed and stops startup with exit code 2, so remove the `.lock.takeover` file by hand if no pulse-notify runs. The new holder writes its lock and reads it back to confirm its own token. If a heartbeat finds another token in the file, the service logs `state lock lost, stopping` and exits 2 without writing the ledger again.

Cost: after a hard crash on another host, a restart there is refused for up to one lease; Docker's restart policy tries again. Limit: two containers that are deliberately given the same host name and the same pid on one volume defeat rule 2.

### Failed events and resend

An event that ends as `failed` (a [permanent error](channels.md#delivery-and-retries) or the last attempt) keeps its notification in the ledger. With the service stopped, list and resend them:

```sh
node src/index.ts failed list
node src/index.ts failed resend 12:opened
node src/index.ts failed resend 12:opened --channel ops-hook
node src/index.ts failed resend --all
node src/index.ts failed resend --all --channel ops-hook
```

(In Docker: `docker run --rm -v pulse-notify-data:/data -e PULSE_NOTIFY_STATE=/data/notify-state.json pulse-notify:local node src/index.ts failed list`.)

- `failed list` prints one tab-separated line per failed entry: channel, key, failure time (UTC), event, and `payload` or `no payload`. With no entries it prints `no failed notifications` and exits 0.
- `failed resend` sets the entry back to `pending` with the same key and stored notification. The service sends it at its next start through the normal pending path, with the same `idempotency-key`. Reminders go through the same stale check, so a resent reminder of a resolved incident is dropped.
- The command needs only `PULSE_NOTIFY_STATE` (and `PULSE_NOTIFY_LOCK_LEASE_SECONDS` if set). It does not read the config file and starts no service, listener or poller. It takes the state lock, so it refuses while the service runs.
- An entry written by an older version has no payload: it is listed as `no payload` and cannot be resent. A single `resend` of it exits 1; with `--all` it is skipped and reported, and the exit code is 1.

| Exit code | Meaning                                                             |
| --------- | ------------------------------------------------------------------- |
| `0`       | Done (also: nothing to list or resend)                              |
| `1`       | Unknown key, no payload, skipped entries with `--all`, or bad usage |
| `2`       | State file in use by a live process, or the state file is unusable  |

Backup: copy the file. It is replaced atomically, so a copy is always a whole file. Restoring is putting the file back with pulse-notify stopped. This was not tested as a procedure beyond that.

If you delete the ledger, every channel counts as new on the next start. It records the current incidents as `seeded` and sends nothing for them. If you remove a channel id and add it back later, it is not seeded again: the ledger keeps the channel. The re-added channel receives the incidents from the time it was removed.

## Restart behavior

- The environment and the config file are read at start. To change a channel, a URL or a setting, restart.
- At start, every `pending` ledger entry that has a stored notification is sent again, oldest first, before the first poll. Pending `reminder` entries are the exception: they are held until the first successful poll. Then a reminder of a resolved incident is dropped (ledger `dropped`, nothing sent), and a reminder is dropped when a newer reminder of the same incident and channel is queued or is in the ledger with any status except `dropped`. While the first poll keeps failing, held reminders stay `pending`. One `info` line `resending pending notifications` per channel gives the `count`. This only applies to channels that are already in the ledger.
- A `pending` entry written by an older version has no stored notification. The poll rebuilds it from the API incident (key `<id>:<event>`) and sends it. If the incident is no longer returned, `pending notification cannot be rebuilt: incident not found` is logged once per start and the key stays `pending`.
- Events that failed stay `failed` and are not retried by the service (unless `PULSE_NOTIFY_RETRY_ATTEMPTS=0`). Use [`failed resend`](#failed-events-and-resend).
- Enabling `remindEverySeconds` on an existing channel does not send a burst of reminders, see [channels.md](channels.md#reminders).
- `SIGINT` and `SIGTERM`: polling stops, sleeps and sends in flight are aborted, unfinished keys stay `pending` (so they are resent at the next start), and batched ledger changes are written, the state lock is removed, and the process exits with 0 once the workers are done. It waits at most 5 seconds for that. A send that was in flight has an unknown result and is sent again, so a duplicate is possible.
- If pulse-api is down, stalls or sends malformed data, pulse-notify keeps running and polls again on the next tick. An incident with a bad `id`, `checkId`, `openedAt` or `resolvedAt` (including a timestamp outside the range of a JavaScript `Date`, ±8.64e15 ms) is skipped with an `error` log (`incident skipped: malformed data`, once per incident id and process). It creates no ledger entry and is checked again on every poll. Other incidents are still processed.
- Ledger write errors do not stop the process. A failed `claim` means the event is not sent and the next poll tries again. A failed `settle` (or a failed batched write, logged as `ledger write failed, pending keys are resent`) leaves the key `pending` on disk, so it is sent again at the next start. A failed `seed` leaves the channel unseeded and the next poll tries again.

## Logs

Logs are JSON lines on stderr. Each line has `time` (ISO 8601 UTC), `level` (`debug`, `info`, `warn` or `error`), `msg` and extra fields.

| Level   | `msg`                                                        | Fields                                                                                                          |
| ------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `info`  | `pulse-notify started`                                       | `channels` (ids), `apiUrl` (without user info, query and fragment)                                              |
| `info`  | `channel seeded with existing incidents`                     | `channel`, `incidents`                                                                                          |
| `info`  | `resending pending notifications`                            | `channel`, `count`                                                                                              |
| `info`  | `notification delivered`                                     | `channel`, `key`, `attempts`                                                                                    |
| `warn`  | `delivery attempt failed`                                    | `channel`, `key`, `attempt`, `error`, `code`, `cause`                                                           |
| `error` | `notification delivery failed`                               | `channel`, `key`, `attempts`, `error`, `code`, `cause`; for a permanent error also `permanent: true` and `note` |
| `info`  | `old ledger entries pruned`                                  | `count`                                                                                                         |
| `info`  | `reminders enabled: due reminders of open incidents skipped` | `channel`                                                                                                       |
| `warn`  | `taking over a stale state lock`                             | `path`, `holderHostname`, `holderPid`                                                                           |
| `error` | `state lock lost, stopping`                                  | `error`                                                                                                         |
| `error` | `ledger write failed, pending keys are resent`               | `error`                                                                                                         |
| `error` | `notification cannot be built, the next poll retries`        | `channel`, `key`, `error`, `code`, `cause`                                                                      |
| `error` | `api poll failed`                                            | `error`, `code`, `cause`                                                                                        |
| `error` | `incident skipped: malformed data`                           | `incidentId`, `reason`                                                                                          |
| `error` | `pending notification cannot be rebuilt: incident not found` | `channel`, `key`                                                                                                |
| `error` | `ledger claim failed, the next poll retries`                 | `channel`, `key`, `error`                                                                                       |
| `error` | `ledger settle failed, the key stays pending`                | `channel`, `key`, `error`                                                                                       |
| `error` | `ledger seed failed, the next poll retries`                  | `channel`, `error`                                                                                              |

`error` is the message of the error. `code` (for example `ECONNREFUSED`, `ENOTFOUND`, `CERT_HAS_EXPIRED`) and `cause` (the message of the innermost cause) appear when the error has them. `fetch failed` alone says little; `code` and `cause` say why.

`PULSE_LOG_LEVEL` sets the lowest level written (default `info`; `debug` is the most verbose).

Startup errors are not JSON. They are one line on stderr: `pulse-notify: <message>`, exit code 2, no stack. This covers environment variables, the config file (including unknown keys) and an unusable state file.

## Exit codes

| Code | Meaning                                                                               |
| ---- | ------------------------------------------------------------------------------------- |
| `0`  | Clean stop after `SIGINT` or `SIGTERM` (also when the 5 s bound was hit).             |
| `2`  | Configuration or startup error, the state file is in use, or the state lock was lost. |
| `1`  | Unexpected failure while running.                                                     |

The signal handlers are registered before the settings, the config and the ledger are read. A second signal does nothing more.

## Health and metrics

Set `PULSE_HEALTH_PORT` to start an HTTP listener (off by default) on `PULSE_HEALTH_HOST` (default `127.0.0.1`). It has no authentication: do not publish it. The Docker image enables it on `0.0.0.0:9100` and has a `HEALTHCHECK` on it; Compose should not publish the port.

The listener binds before polling starts. If the bind fails, the service prints one line and exits 2. If a stop takes longer than 5 s on SIGINT/SIGTERM, it logs a `warn` line and exits 0.

- `GET /healthz`: `200 ok` once the poll loop runs, `503` with a reason while starting, while shutting down, and while polls fail: after `PULSE_NOTIFY_HEALTH_MAX_FAILED_POLLS` (default 5) failed polls in a row it answers `503 polls failing (<n> in a row)`. A poll fails when the API fetch or the detection threw (including a body over `PULSE_NOTIFY_API_MAX_BYTES`); a poll that fetched fine but had rejected items is good. One good poll resets the count and `/healthz` is `200` again. A Docker `HEALTHCHECK` on `/healthz` therefore marks a notifier unhealthy when pulse-api has been unreachable for 5 polls (25 s with the defaults).
- `GET /readyz`: the same check, status and body as `/healthz` (added with the shared pulse-kit ops server). `/healthz` and `/readyz` both answer `HEAD`; a method other than `GET` and `HEAD` answers `405`.
- `GET /metrics`: Prometheus text. Counters reset on restart.

| Series                                                              | Type            |
| ------------------------------------------------------------------- | --------------- |
| `pulse_up`                                                          | gauge, always 1 |
| `pulse_notify_polls_total{outcome="ok\|error"}`                     | counter         |
| `pulse_notify_deliveries_total{channel,outcome="success\|failure"}` | counter         |
| `pulse_notify_pending_deliveries`                                   | gauge           |
| `pulse_notify_consecutive_failed_polls`                             | gauge           |

`channel` is the channel id. Webhook URLs, paths and secrets never appear.

## API validation and version check

The API calls go through `fetchJson` of `@lorenzh/pulse-contract`, which owns the timeout, the size cap and the wire check. Every item from `GET /incidents` and `GET /checks` is validated with the validators of `@lorenzh/pulse-contract` (`validateIncident`, `validateCheck`). An invalid incident or check is skipped and logged once with a path such as `incidents[0].checkId: ...`. Incidents also need `openedAt` and `resolvedAt` inside the range of `Date` (±8.64e15 ms). The validators enforce the bounds of the contract; an item outside them is skipped, the other items are still used.

A response body is read as a stream and stops at `PULSE_NOTIFY_API_MAX_BYTES` (default 5 MiB). A `Content-Length` over the cap fails at once; a body that grows past the cap is cut off even without or with a wrong length. Both fail the poll and count as a failed poll.

Each API response is checked with `checkWireVersion` against the `x-pulse-contract` header. A mismatch fails the poll like a network error (logged as `api poll failed`). A missing header is logged once as a warning and the poll continues. The status is checked before the header: a non-2xx response fails as `GET <path> returned <n>`, even when its header mismatches.
