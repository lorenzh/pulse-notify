# Operation

## State: the delivery ledger

pulse-notify keeps one state file, the delivery ledger. Its path is `PULSE_NOTIFY_STATE` (default `./notify-state.json`; `/data/notify-state.json` in the Docker image).

- A SQLite database (`bun:sqlite`), format 4 (`PRAGMA user_version = 4`), in WAL mode with `synchronous = FULL`. The name keeps `.json` so existing settings and volumes work. SQLite keeps `<state>-wal` and `<state>-shm` beside it. Table `channels` holds per channel `reminders_from`, `manual_from` and the routing fingerprints; table `entries` holds `channel_id`, `key`, `status`, `at` (epoch ms of the last status change), `payload` (the notification of a `pending` or `failed` key, so it can be resent) and `recipients` (email recipient progress, or NULL); table `alert_state` holds per `kind` (`budget-check`, `budget-component`, `expiry`) and `subject_id` the state of the budget and expiry warnings: `last_event_at` for a budget row, `stage` (14, 3 or NULL), `episode_at` and `observed_at` for an expiry row, and `updated_at` (epoch ms of the commit of the last change). A bad row, or a format-4 file without this table, refuses the file.
- A format-3 database is migrated at start, in this order, so no step deletes the only copy of a committed row: the file is validated read-only (a refused file keeps the bytes of its main file, `-wal` and `-shm`); its WAL is checkpointed into the main file (`synchronous = FULL`, `wal_checkpoint(TRUNCATE)`); when the checkpoint is blocked, for example by another open connection, the start fails with `ledger checkpoint was blocked` and nothing is deleted or written; the rows are read and validated again; an old `<state>.v3.bak` is removed (a symlink is removed, not followed) and the checkpointed file is copied to a new private `<state>.v3.bak` (mode `0600`); then the format-4 file is built at `<state>.migrating` (mode `0600`) and renamed over the path. Every channel, mark, entry, payload and recipient record is kept. The service logs `ledger migrated` with `from: 3`. An interruption at any step leaves a format-3 file with every row, and the next start migrates again with the same rows. A leftover `<state>.v3.bak.<suffix>.tmp` from a crash is not read.
- A JSON ledger of format 1 or 2 is migrated at start directly to format 4: the database is built at `<state>.migrating`, the original is copied byte for byte to `<state>.v<N>.bak`, stale `<state>-wal`, `-shm` and `-journal` files are removed, and the database is renamed over the path. The service logs `ledger migrated` (`from`, `entries`, `backup`). An interruption before the rename leaves the JSON in place and the next start migrates again. `failed list|resend` migrates too. A SQLite file with another `user_version` or a row that breaks the format, and a JSON file with a newer version, stop the process without a change, see [troubleshooting.md](troubleshooting.md).
- Status is `seeded`, `pending`, `delivered`, `failed` or `dropped`.
- Durability: every change (`seed`, `claim` before the first send, `settle`, `resend`, recipient progress, the reminder mark, pruning) is one transaction that writes only the rows it changes and is on disk before it returns. A failed write rolls back and leaves memory unchanged. Nothing is batched. A crash between a send and its settle leaves the key `pending`, so it is sent again at the next start (at-least-once). Shutdown checkpoints the WAL (`<state>-wal` is then empty) and closes the database. The parent directory is created if missing. Do not put the state on a network file system: WAL needs shared memory.
- The ledger is read once at start. Do not edit it while pulse-notify runs.
- Retention: at the first poll and then once per hour, entries with status `delivered`, `dropped`, `failed` or `seeded` that are older than `PULSE_NOTIFY_STATE_RETENTION_DAYS` (default 30) are removed with their payloads. `pending` entries are never pruned. A key of an incident that the last successful poll still lists is kept, however old, because without it the event would look unhandled and be sent again. This means pulse-api must keep an incident at least as long as the retention, or the key of an incident that is still listed could be pruned: the guard covers that case, but keep the two settings in line. Before the first successful poll no incident key is pruned.
- Alert-state retention: an `alert_state` row is removed only when its `updated_at` is older than `PULSE_NOTIFY_STATE_RETENTION_DAYS` and its subject id was absent from the last good read of its feed in this run (an item that is listed but fails validation still counts as present) (`/checks` for `budget-check` and `expiry`, `/components` for `budget-component`). Before a good read of that feed in this run, no row of that kind is removed; a `404` on `/components` is not a good read. This does not depend on the delivery entries: a `budget:` or `expiry:` entry is pruned like other old entries, and its row stays.

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
bun src/index.ts failed list
bun src/index.ts failed resend 12:opened
bun src/index.ts failed resend 12:opened --channel ops-hook
bun src/index.ts failed resend --all
bun src/index.ts failed resend --all --channel ops-hook
```

(In Docker: `docker run --rm -v pulse-notify-data:/data -e PULSE_NOTIFY_STATE=/data/notify-state.json pulse-notify:local bun --no-env-file src/index.ts failed list`.)

- `failed list` prints one tab-separated line per failed entry: channel, key, failure time (UTC), event, and `payload` or `no payload`. With no entries it prints `no failed notifications` and exits 0.
- `failed resend` sets the entry back to `pending` with the same key and stored notification. The service sends it at its next start through the normal pending path, with the same `idempotency-key`. Reminders go through the same stale check, so a resent reminder of a resolved incident is dropped.
- The command needs only `PULSE_NOTIFY_STATE` (and `PULSE_NOTIFY_LOCK_LEASE_SECONDS` if set). It does not read the config file and starts no service, listener or poller. It takes the state lock, so it refuses while the service runs.
- An entry written by an older version has no payload: it is listed as `no payload` and cannot be resent. A single `resend` of it exits 1; with `--all` it is skipped and reported, and the exit code is 1.

| Exit code | Meaning                                                             |
| --------- | ------------------------------------------------------------------- |
| `0`       | Done (also: nothing to list or resend)                              |
| `1`       | Unknown key, no payload, skipped entries with `--all`, or bad usage |
| `2`       | State file in use by a live process, or the state file is unusable  |

Backup: stop pulse-notify, then copy `<state>`. A clean stop checkpoints, so `<state>-wal` is empty. A copy of the live file is not safe. Restore: stop pulse-notify, remove `<state>-wal` and `<state>-shm`, put the file back, start.

If you delete the ledger, every channel counts as new on the next start. It records the current incidents as `seeded` and sends nothing for them. If you remove a channel id and add it back later, it is not seeded again: the ledger keeps the channel. The re-added channel receives the incidents from the time it was removed.

## Manual incidents

Manual incident events share the ledger with automatic ones. Their keys start with `manual:`; the pruning of old settled entries keeps the keys of manual incidents that the api still lists. An update key is `manual:<id>:update:<32 hex>`, a hash of the update's `at`, `status` and `message`, so it stays the same when updates are inserted or reordered (see [channels.md](channels.md#manual-incidents)). `failed list` shows their event as `opened`, `update` (both the stable form and the older `update:<n>` form), or `resolved`.

The ledger keeps a per-channel `manualFrom` time: the first good `GET /manual-incidents` read (an array, also `[]`) for the channel. A channel without it, for example from an older version, records the manual incidents and updates of that read as `seeded` and sends none of them; then `manualFrom` is set in the same write. A 404 or a failed read sets nothing, so a later good read seeds. The mark is never cleared. A new channel gets it with its first seed, unless the api answered 404.

## Restart behavior

- The environment and the config file are read at start. To change a channel, a URL or a setting, restart.
- At start, every `pending` ledger entry that has a stored notification is sent again, oldest first, before the first poll. Pending `reminder` entries are the exception: they are held until the first successful poll. Then a reminder of a resolved incident is dropped (ledger `dropped`, nothing sent), and a reminder is dropped when a newer reminder of the same incident and channel is queued or is in the ledger with any status except `dropped`. While the first poll keeps failing, held reminders stay `pending`. One `info` line `resending pending notifications` per channel gives the `count`. This only applies to channels that are already in the ledger.
- A `pending` entry written by an older version has no stored notification. The poll rebuilds it from the API incident (key `<id>:<event>`) and sends it. If the incident is no longer returned, `pending notification cannot be rebuilt: incident not found` is logged once per start and the key stays `pending`.
- Events that failed stay `failed` and are not retried by the service (unless `PULSE_NOTIFY_RETRY_ATTEMPTS=0`). Use [`failed resend`](#failed-events-and-resend).
- Enabling `remindEverySeconds` on an existing channel does not send a burst of reminders, see [channels.md](channels.md#reminders).
- `SIGINT` and `SIGTERM`: polling stops, sleeps and sends in flight are aborted, unfinished keys stay `pending` (so they are resent at the next start), the ledger is checkpointed and closed, the state lock is removed, and the process exits with 0 once the workers are done. It waits at most 5 seconds for that; a longer stop logs a `warn` line and exits with 1. A send that was in flight has an unknown result and is sent again, so a duplicate is possible.
- If pulse-api is down, stalls or sends malformed data, pulse-notify keeps running and polls again on the next tick. The three reads of a poll (`incidents`, `checks`, `manual-incidents`) run in parallel and settle on their own: a failing read skips only the work that needs it, see [Failing feeds](#failing-feeds). An incident with a bad `id`, `checkId`, `openedAt` or `resolvedAt` (including a timestamp outside the range of a JavaScript `Date`, ±8.64e15 ms) is skipped with an `error` log (`incident skipped: malformed data`). The same holds for a bad manual incident; a draft or internal-only manual incident is not malformed: it is dropped without a log, a metric, or a ledger entry (see [channels.md](channels.md#manual-incidents)); a bad check is skipped with a `warn` log (`check skipped: malformed data`). Each skipped item on any of the three feeds is counted in `pulse_notify_skipped_items_total` on every poll, but logged once per identity: the integer id, or the array index when the id is not an integer. At most 1024 identities are kept; the oldest is evicted first, so it can log again. A skipped item creates no ledger entry and is checked again on every poll. Other items are still processed.
- Ledger write errors do not stop the process. A failed `claim` means the event is not sent and the next poll tries again. A failed `settle` leaves the key `pending` on disk, so it is sent again at the next start. A failed `seed` leaves the channel unseeded and the next poll tries again. A failed prune is logged and retried at the next prune.

## Failing feeds

Each poll reads `GET /incidents`, `GET /checks` and `GET /manual-incidents`, and `GET /components` when a channel has `budget-low` in `alerts`. A 404 on `components` means no components and does not fail the poll; any other failure of it counts for `/readyz` like the other feeds and skips only the component budgets. The items of `checks` are also validated with the full check state only when a channel has `alerts`; an item that fails that second check keeps its name and is counted under `pulse_notify_skipped_items_total{feed="checks"}`. The feed names in logs and metrics are these paths. A 404 on `manual-incidents` (an older api) counts as an answer with no manual incidents. When a feed fails, the poll uses the feeds that answered:

| Failing feed       | Skipped this poll                                                                                                                                                  | Still done                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `incidents`        | Automatic incident events, reminders, the reminder mark, rebuilding older pending keys, releasing held reminders, the ledger prune. The last incident set is kept. | Manual incident events on channels that are already seeded.         |
| `checks`           | Nothing. Check names come from the last good `checks` read; a check without a known name uses its id.                                                              | Everything else.                                                    |
| `manual-incidents` | Manual incident events. The last set of visible manual incident ids is kept, so the prune does not remove their keys.                                              | Automatic incident events, reminders, held reminders and the prune. |

A good `checks` read replaces the known names: a check that is no longer listed loses its name. A channel that is not in the ledger yet is seeded only in a poll where `incidents` and `manual-incidents` both answered; otherwise the next poll tries again. This way a recovered feed does not send a burst of old incidents.

## Logs

Logs are JSON lines on stderr. Each line has `time` (ISO 8601 UTC), `level` (`debug`, `info`, `warn` or `error`), `msg` and extra fields.

| Level   | `msg`                                                               | Fields                                                                                                          |
| ------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `info`  | `pulse-notify started`                                              | `channels` (ids), `apiUrl` (without user info, query and fragment)                                              |
| `info`  | `channel seeded with existing incidents`                            | `channel`, `incidents`                                                                                          |
| `info`  | `resending pending notifications`                                   | `channel`, `count`                                                                                              |
| `info`  | `notification delivered`                                            | `channel`, `key`, `attempts`                                                                                    |
| `warn`  | `delivery attempt failed`                                           | `channel`, `key`, `attempt`, `error`, `code`, `cause`                                                           |
| `warn`  | `delivery attempt partly refused`                                   | `channel`, `key`, `attempt`, `delivered`, `refused`, `remaining` (counts), `codes` (sorted reply codes)         |
| `error` | `ledger recipient write failed`                                     | `channel`, `key`, `error`, `code`, `cause`                                                                      |
| `error` | `notification delivery failed`                                      | `channel`, `key`, `attempts`, `error`, `code`, `cause`; for a permanent error also `permanent: true` and `note` |
| `info`  | `old ledger entries pruned`                                         | `count`                                                                                                         |
| `info`  | `old alert state pruned`                                            | `count`                                                                                                         |
| `info`  | `incident notifications dropped: channel sends no incidents`        | `channel`, `count` (once per channel with `sendIncidents: false` and count above 0, at start)                   |
| `warn`  | `component skipped: malformed data`                                 | `feed` (`components`), `index`, `reason` (`invalid`); once per index                                            |
| `error` | `alert state write failed, the next poll retries`                   | `error`                                                                                                         |
| `error` | `incident seed failed, the next poll retries`                       | `channel`, `error`                                                                                              |
| `info`  | `ledger migrated`                                                   | `from`, `entries`, `backup`                                                                                     |
| `error` | `ledger prune failed, the next prune retries`                       | `error`                                                                                                         |
| `info`  | `reminders enabled: due reminders of open incidents skipped`        | `channel`                                                                                                       |
| `info`  | `routing changed: history of newly routed checks skipped`           | `channel`, `incidents` (count of newly routed incidents)                                                        |
| `info`  | `routing changed: history of newly routed manual incidents skipped` | `channel`, `incidents` (count of newly routed manual incidents)                                                 |
| `warn`  | `taking over a stale state lock`                                    | `path`, `holderHostname`, `holderPid`                                                                           |
| `error` | `state lock lost, stopping`                                         | `error`                                                                                                         |
| `error` | `notification cannot be built, the next poll retries`               | `channel`, `key`, `error`, `code`, `cause`                                                                      |
| `error` | `api poll failed`                                                   | `feed`, `error`, `code`, `cause`; logged once per feed and failure kind while the feed keeps failing            |
| `info`  | `api feed recovered`                                                | `feed`, after a logged failure of that feed                                                                     |
| `info`  | `manual incidents initialized: existing manual incidents skipped`   | `channel`, `incidents`                                                                                          |
| `error` | `incident skipped: malformed data`                                  | `feed` (`incidents` or `manual-incidents`), `index`, `reason`, and `incidentId` only when the id is an integer  |
| `warn`  | `check skipped: malformed data`                                     | `feed` (`checks`), `index`, `reason` (`invalid`)                                                                |
| `error` | `pending notification cannot be rebuilt: incident not found`        | `channel`, `key`                                                                                                |
| `error` | `ledger claim failed, the next poll retries`                        | `channel`, `key`, `error`                                                                                       |
| `error` | `ledger settle failed, the key stays pending`                       | `channel`, `key`, `error`                                                                                       |
| `error` | `ledger seed failed, the next poll retries`                         | `channel`, `error`                                                                                              |

`feed` is `incidents`, `checks` or `manual-incidents`. A failure kind is the kind of `fetchJson` failure (`timeout`, `network`, `too-large`, ...); an HTTP failure includes its status, so `500` and then `503` log twice. When the feed answers again, the next failure logs again. An unreachable api therefore logs three lines (one per feed) once, not one line per poll; the metrics still count every failed read.

`error` is the message of the error. `code` (for example `ECONNREFUSED`, `ENOTFOUND`, `CERT_HAS_EXPIRED`) and `cause` (the message of the innermost cause) appear when the error has them. `fetch failed` alone says little; `code` and `cause` say why.

`PULSE_LOG_LEVEL` sets the lowest level written (default `info`; `debug` is the most verbose).

Startup errors are not JSON. They are one line on stderr: `pulse-notify: <message>`, exit code 2, no stack. This covers environment variables, the config file (including unknown keys) and an unusable state file.

## Exit codes

| Code | Meaning                                                                               |
| ---- | ------------------------------------------------------------------------------------- |
| `0`  | Clean stop after `SIGINT` or `SIGTERM`.                                               |
| `2`  | Configuration or startup error, the state file is in use, or the state lock was lost. |
| `1`  | Unexpected failure while running, or a stop that took longer than the 5 s bound.      |

The signal handlers are registered before the settings, the config and the ledger are read. A second signal does nothing more.

## Health and metrics

Set `PULSE_HEALTH_PORT` to start an HTTP listener (off by default) on `PULSE_HEALTH_HOST` (default `127.0.0.1`). It has no authentication: do not publish it. The Docker image enables it on `0.0.0.0:9100` and has a `HEALTHCHECK` on `127.0.0.1:$PULSE_HEALTH_PORT/healthz` (9100 when unset or empty, read at run time; port 0 is not supported); Compose should not publish the port.

The listener binds before polling starts. If the bind fails, the service prints one line and exits 2. If a stop takes longer than 5 s on SIGINT/SIGTERM, it logs a `warn` line and exits 1.

- `GET /healthz` (liveness, the lifecycle only): `200 ok` once the poll loop runs, `503 starting` before that, and `503 shutting down` once a stop began, also after a lost state lock. It never reads the feed health, so failing polls do not get a working notifier restarted. The Docker `HEALTHCHECK` uses it.
- `GET /readyz` (feed health): `503` while starting and shutting down, and after `PULSE_NOTIFY_HEALTH_MAX_FAILED_POLLS` (default 5) failed polls in a row `503 polls failing (<n> in a row)`. A poll fails when any of the three feeds failed (including a body over `PULSE_NOTIFY_API_MAX_BYTES` or a redirect) or the detection threw; a 404 on `manual-incidents` and a read with rejected items are good. The feeds that answered are still used meanwhile. One good poll resets the count and `/readyz` is `200` again. Monitor `/readyz` or `pulse_notify_consecutive_failed_polls` to see a failing api. `/healthz` and `/readyz` both answer `HEAD`; a method other than `GET` and `HEAD` answers `405`.
- `GET /metrics`: Prometheus text. Counters reset on restart.

| Series                                                              | Type            |
| ------------------------------------------------------------------- | --------------- |
| `pulse_up`                                                          | gauge, always 1 |
| `pulse_notify_polls_total{outcome="ok\|error"}`                     | counter         |
| `pulse_notify_feed_polls_total{feed,outcome="ok\|error"}`           | counter         |
| `pulse_notify_deliveries_total{channel,outcome="success\|failure"}` | counter         |
| `pulse_notify_pending_deliveries`                                   | gauge           |
| `pulse_notify_consecutive_failed_polls`                             | gauge           |
| `pulse_notify_skipped_items_total{feed}`                            | counter         |

`pulse_notify_polls_total` counts the feed reads of a poll, before detection and enqueue: `ok` when all three feeds answered (a 404 on `manual-incidents` included), `error` when any read failed; the feeds that answered are still used. It does not measure delivery: an `error` poll can still send events, and an `ok` poll can send none. A detection failure after the reads leaves the outcome `ok` but adds 1 to `pulse_notify_consecutive_failed_polls`; each `error` poll also adds 1, and a fully good poll resets it to 0. `/readyz` fails when the streak reaches `PULSE_NOTIFY_HEALTH_MAX_FAILED_POLLS` (default 5, minimum 1). At the default of 5, starting from zero failures, one failed poll keeps it ready and the fifth failure in a row fails it; with `PULSE_NOTIFY_HEALTH_MAX_FAILED_POLLS=1` the first failed poll fails it. Monitor delivery with `pulse_notify_deliveries_total` and `pulse_notify_pending_deliveries`, and feed health with `pulse_notify_feed_polls_total`, `pulse_notify_consecutive_failed_polls` and `/readyz`. `pulse_notify_feed_polls_total` counts each read once per poll; `feed` is `incidents`, `checks` or `manual-incidents`, and a 404 on `manual-incidents` is `ok`. `channel` is the channel id. Webhook URLs, paths and secrets never appear.

## API validation and version check

The API calls go through `fetchJson` of `@lorenzh/pulse-contract`, which owns the timeout, the size cap and the wire check. Every item from `GET /incidents` and `GET /checks` is validated with the validators of `@lorenzh/pulse-contract` (`validateIncident`, `validateCheck`). `validateCheck` knows all six check types: `http`, `tls`, `heartbeat`, `tcp`, `dns` and `domain`. An invalid incident or check is skipped and logged once with its `feed`, `index` and a fixed `reason`; the contract's error text is not logged. Incidents also need `openedAt` and `resolvedAt` inside the range of `Date` (±8.64e15 ms). The validators enforce the bounds of the contract; an item outside them is skipped, the other items are still used.

A response body is read as a stream and stops at `PULSE_NOTIFY_API_MAX_BYTES` (default 5 MiB). A `Content-Length` over the cap fails at once; a body that grows past the cap is cut off even without or with a wrong length. Both fail the read of that feed and count as a failed poll.

Each API response is checked with `checkWireVersion` against the `x-pulse-contract` header. A mismatch fails the read of that feed like a network error (logged as `api poll failed`). A missing header is logged once as a warning and the poll continues. The status is checked before the header: a non-2xx response fails as `GET <path> returned <n>`, even when its header mismatches.

No redirect is followed, also not a same-origin one: a `3xx` answer fails the read as `GET <path> returned <n>` (on `manual-incidents` too; only 404 counts as absent). `PULSE_API_URL` must point at the final endpoint. Text from an api response never reaches a log line: no body, parser message, header value, `Location`, raw id or contract reason. Invalid JSON logs `GET <path> returned invalid JSON`, a wire mismatch `GET <path> wire version mismatch (expected <version>)`, and a body that is not an array `GET <path> did not return an array`.

## Upgrading

From a version without `manualFrom` in the ledger:

- Manual incidents: on the first good `/manual-incidents` read after the upgrade, every channel records the manual incidents and updates it then sees as handled and sends none of them. Updates made while notify was stopped for the upgrade are not sent. A 404 from an older api postpones this until the api serves the feed.
- Update keys change from `manual:<id>:update:<n>` to `manual:<id>:update:<32 hex>`. Old positional entries stay until pruned. Pending and failed ones are still resent.
- A downgrade after this upgrade resends the manual updates of known channels once.
- `/healthz` no longer reflects feed health; monitor `/readyz` or `pulse_notify_consecutive_failed_polls`.
- `pulse_notify_polls_total{outcome="error"}` no longer means that nothing was delivered: the feeds that answered are still used. Alert on delivery with `pulse_notify_deliveries_total` and `pulse_notify_pending_deliveries`, see [Health and metrics](#health-and-metrics).

From a version with a SQLite state file of format 3:

- The first start migrates the file to format 4 and keeps the checkpointed original as `<state>.v3.bak` (mode `0600`, logged as `ledger migrated` with `from: 3`). A later start does not migrate again.
- Downgrade to a format-3 version: stop, restore `<state>.v3.bak` to `<state>`, remove `<state>-wal` and `<state>-shm`. A format-3 version refuses a format-4 file. Events settled after the migration may then be sent again, and the alert state is lost.

From a version with a JSON state file (format 1 or 2):

- The first start migrates the file to SQLite format 4 and keeps the original as `<state>.v<N>.bak` (logged as `ledger migrated`). Statuses, times, payloads and marks are kept. A later start does not migrate again.
- Routing filters are stored from the first poll after the upgrade on. A filter widening made in the same restart as the upgrade sends the history of the newly routed checks once. Upgrade first, then change filters in a later restart, see [channels.md](channels.md#routing).
- Backup now needs a stopped service, see [State: the delivery ledger](#state-the-delivery-ledger).
- Downgrade to a JSON version: stop, restore the backup that the `ledger migrated` log line names as `backup` to `<state>` (`<state>.v1.bak` if the migration was from format 1, `<state>.v2.bak` if from format 2), remove `<state>-wal` and `<state>-shm`. Events settled after the migration may then be sent again.
