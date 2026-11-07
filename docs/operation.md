# Operation

## State: the delivery ledger

pulse-notify keeps one state file, the delivery ledger. Its path is `PULSE_NOTIFY_STATE` (default `./notify-state.json`; `/data/notify-state.json` in the Docker image).

- A SQLite database (`bun:sqlite`), format 5 (`PRAGMA user_version = 5`), in WAL mode with `synchronous = FULL`. The name keeps `.json` so existing settings and volumes work. SQLite keeps `<state>-wal` and `<state>-shm` beside it. Table `channels` holds per channel `reminders_from`, `manual_from` and the routing fingerprints; table `entries` holds `channel_id`, `key`, `status`, `at` (epoch ms of the last status change), `payload` (the notification of a `pending` or `failed` key, so it can be resent) and `recipients` (email recipient progress, or NULL); table `alert_state` holds per `kind` (`budget-check`, `budget-component`, `expiry`) and `subject_id` the state of the budget and expiry warnings: `last_event_at` for a budget row, `stage` (14, 3 or NULL), `episode_at` and `observed_at` for an expiry row, and `updated_at` (epoch ms of the commit of the last change); table `remote_channels` holds per database channel id the canonical `definition` of its last applied version (references only, never a secret value), the `revision` of the channels answer it came from and `applied_at`; table `resend_commands` holds per resend command id its `channel_id`, `key`, notify `state`, the `posted_state` that the api acknowledged and `updated_at`. A finished command row that the api acknowledged is pruned after 7 days. A bad row, or a file without one of its tables, refuses the file.
- A format-3 or format-4 database is migrated to format 5 at start, in this order, so no step deletes the only copy of a committed row: the file is validated read-only (a refused file keeps the bytes of its main file, `-wal` and `-shm`); its WAL is checkpointed into the main file (`synchronous = FULL`, `wal_checkpoint(TRUNCATE)`); when the checkpoint is blocked, for example by another open connection, the start fails with `ledger checkpoint was blocked` and nothing is deleted or written; the rows are read and validated again; an old `<state>.v<N>.bak` (`N` is 3 or 4) is removed (a symlink is removed, not followed) and the checkpointed file is copied to a new private `<state>.v<N>.bak` (mode `0600`); then the format-5 file is built at `<state>.migrating` (mode `0600`) and renamed over the path. Every channel, mark, entry, payload and recipient record is kept, and from format 4 every `alert_state` row; a format-3 file starts with an empty alert state. The two new tables start empty. The service logs `ledger migrated` with `from: 3` or `from: 4`. An interruption at any step leaves the old file with every row, and the next start migrates again with the same rows. A leftover `<state>.v<N>.bak.<suffix>.tmp` from a crash is not read.
- A JSON ledger of format 1 or 2 is migrated at start directly to format 5: the database is built at `<state>.migrating`, the original is copied byte for byte to `<state>.v<N>.bak`, stale `<state>-wal`, `-shm` and `-journal` files are removed, and the database is renamed over the path. The service logs `ledger migrated` (`from`, `entries`, `backup`). An interruption before the rename leaves the JSON in place and the next start migrates again. `failed list|resend` migrates too. A SQLite file with another `user_version` or a row that breaks the format, and a JSON file with a newer version, stop the process without a change, see [troubleshooting.md](troubleshooting.md).
- Status is `seeded`, `pending`, `delivered`, `failed` or `dropped`.
- Durability: every change (`seed`, `claim` before the first send, `settle`, `resend`, recipient progress, the reminder mark, pruning) is one transaction that writes only the rows it changes and is on disk before it returns. A failed write rolls back and leaves memory unchanged. Nothing is batched. A crash between a send and its settle leaves the key `pending`, so it is sent again at the next start (at-least-once). Shutdown checkpoints the WAL (`<state>-wal` is then empty) and closes the database. The parent directory is created if missing. Do not put the state on a network file system: WAL needs shared memory.
- The ledger is read once at start. Do not edit it while pulse-notify runs.
- Retention: at the first poll and then once per hour, entries with status `delivered`, `dropped`, `failed` or `seeded` that are older than `PULSE_NOTIFY_STATE_RETENTION_DAYS` (default 30) are removed with their payloads. `pending` entries are never pruned. A key of an incident that the last successful poll still lists is kept, however old, because without it the event would look unhandled and be sent again. This means pulse-api must keep an incident at least as long as the retention, or the key of an incident that is still listed could be pruned: the guard covers that case, but keep the two settings in line. Before the first successful poll no incident key is pruned. A manual incident id (any safe integer, negative and `0` included) listed by the last successful `/manual-incidents` read keeps its keys too, even when notify skips the item as a draft, internal or malformed; its content is never sent. A failed or `404` read keeps the last listed ids. Limit: an item that the api omits from the feed is not protected.
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
- Live resend: with `PULSE_NOTIFY_API_TOKEN`, a resend started in the console reaches the running service, see [Live resend](#live-resend). The offline command stays for a stopped service.
- The command needs only `PULSE_NOTIFY_STATE` (and `PULSE_NOTIFY_LOCK_LEASE_SECONDS` if set). It does not read the config file and starts no service, listener or poller. It takes the state lock, so it refuses while the service runs.
- An entry written by an older version has no payload: it is listed as `no payload` and cannot be resent. A single `resend` of it exits 1; with `--all` it is skipped and reported, and the exit code is 1.

| Exit code | Meaning                                                             |
| --------- | ------------------------------------------------------------------- |
| `0`       | Done (also: nothing to list or resend)                              |
| `1`       | Unknown key, no payload, skipped entries with `--all`, or bad usage |
| `2`       | State file in use by a live process, or the state file is unusable  |

### Live resend

With `PULSE_NOTIFY_API_TOKEN`, notify claims up to 20 queued resend commands every `PULSE_NOTIFY_COMMAND_POLL_MS` (default 5000) with `POST /service/notify/resends/claim`. Without a token it makes no such call.

- A command id seen before is never run again; notify posts its stored state once more.
- A new command is admitted in one SQLite transaction: the channel must be installed (else `channel-unavailable`), the key must be `failed` (else `not-failed`) and have a stored notification (else `no-payload`). An admitted key is set back to `pending` with refused email recipients cleared, and the command row is written. The send starts only after this commit. A crash after the commit sends the key at the next start.
- The send uses the normal path: the same `idempotency-key` and Message-ID, delivered email recipients get nothing again, and a stale reminder is dropped. Its final state (`delivered`, `failed` or `dropped`) and every `admitted` command of that channel and key are written in one transaction.
- Each poll posts at most 20 results that the api has not acknowledged, oldest first, to `POST /service/notify/resends/<id>/result`. A `204` acknowledges the state. A `404` or `409` also ends the post and logs `resend result refused by the api` once (`command`, `state`, `postedState`). A timeout, a network error or another status leaves the result for the next poll.
- A successfully resent key leaves the `failed` list of the next report.
- The calls send the token as Bearer only to `/service/*`, follow no redirect, time out after 5000 ms and read at most 1048576 bytes.
- `failed list|resend` still exits 2 while the service holds the lock.

Backup: stop pulse-notify, then copy `<state>`. A clean stop checkpoints, so `<state>-wal` is empty. A copy of the live file is not safe. Restore: stop pulse-notify, remove `<state>-wal` and `<state>-shm`, put the file back, start.

If you delete the ledger, every channel counts as new on the next start. It records the current incidents as `seeded` and sends nothing for them. If you remove a channel id and add it back later, it is not seeded again: the ledger keeps the channel. The re-added channel receives the incidents from the time it was removed.

## Subscriber store

With `PULSE_NOTIFY_SUBSCRIPTIONS=on` the service opens this store at start, after the ledger and before the subscription listener answers. With `off` it opens no store and no store lock.

- A SQLite file at `PULSE_NOTIFY_SUBSCRIPTIONS_STATE`, format 1 (`PRAGMA user_version = 1`), mode `0600`, WAL with `synchronous = FULL` and `secure_delete = ON`, under its own lock `<store>.lock` (the same rules as the [state file lock](#state-file-lock)). A file of another format is refused with exit code 2. Every change is one transaction.
- What it stores, per subscription: the address, the state (pending or confirmed), when it was created, when the last confirmation mail was sent, how many were sent, when it was confirmed, and the SHA-256 digest of the current confirmation token with its expiry. Per incident email: a delivery row with the subscription id (not the address), sent or failed, attempts and time. Events hold public incident content only. Nothing of this goes to logs or metrics.
- After each delete of a subscription the WAL is checkpointed with `TRUNCATE`, so the deleted content is overwritten in the main file and `<store>-wal` is empty. A checkpoint that is busy logs a warning without an address and is retried at the next cleanup. Shutdown checkpoints too.
- Retention: cleanup runs at start and then every hour on its own timer, independent of polls. It deletes a pending subscription whose confirmation link expired, so an unconfirmed address is gone within 25 hours of its last confirmation mail. A confirmed subscription stays until it unsubscribes or is deleted. Delivery rows go with their subscription, or with their event once the event is settled, older than `PULSE_NOTIFY_STATE_RETENTION_DAYS` and no longer listed by the last good manual incident read. Before the first good read no event is pruned, and a pending event is never pruned.
- Deletion on request (no unsubscribe link): with the service stopped, run `pulse-notify subscribers delete <address>`. It normalizes the address, deletes its subscription (pending or confirmed) and its delivery rows in one transaction, checkpoints, prints `deleted 1` or `deleted 0` and exits 0. It needs only `PULSE_NOTIFY_SUBSCRIPTIONS_STATE` (or `PULSE_NOTIFY_STATE` for the default path) and the lock settings, so it also works with subscriptions off. A missing store prints `deleted 0` and creates none. A held lock exits 2 with the lock message, an invalid address exits 1 with `pulse-notify: subscribers delete: invalid address`, and other arguments exit 1 with `usage: pulse-notify subscribers delete <address>`. No output line holds the address. Run it as `bun src/index.ts subscribers delete <address>` (in the image: `bun --no-env-file src/index.ts subscribers delete <address>`).
- Operator procedure for a deletion request: answer the contact that the status page shows, stop pulse-notify, run `subscribers delete <address>`, start pulse-notify, and tell the visitor. Copies in backups, mailboxes and SMTP provider logs are not removed by it; delete expired backups on your stated schedule.

### Subscription listener, confirmation and incident mail

Start order with subscriptions on: settings (a bad value exits 2 before any file is opened), ledger and state lock, store and `<store>.lock` (mode `0600`), first cleanup, subscription listener, health listener, then the notifier, the channel loop and both mail workers. A listener that cannot bind exits 2 with `cannot listen on <host>:<port> (PULSE_NOTIFY_SUBSCRIPTIONS_HOST/PULSE_NOTIFY_SUBSCRIPTIONS_PORT): <reason>` and frees the store, both locks and the ledger. Stop order: the notifier ends first, then the mailbox guard stops, then both workers end (the send in flight is aborted), then the listener closes, the cleanup timer stops, the store is checkpointed and closed, and `<store>.lock` is removed. A lost store lock stops the service with exit 2, like a lost state lock.

- The listener is a private `node:http` server on `PULSE_NOTIFY_SUBSCRIPTIONS_HOST:PORT` with `headersTimeout` and `requestTimeout` of 10 s. Only status calls it. Routes, all `POST`: `/subscriptions` (`{"email"}` → `202 {"status":"accepted"}`), `/subscriptions/confirm` (`{"token"}` → `200 {"status":"confirmed"}`) and `/subscriptions/unsubscribe` (`{"token"}` → `200 {"status":"unsubscribed"}`).
- Checks in this order: unknown path `404`; another method `405` with `allow: POST`; a wrong `Authorization: Bearer` `401` before any body byte is read; a content type other than `application/json` `415`; a body over 1024 bytes `413`; bad JSON or a body that fails the contract validator or the token pattern `400`; an unknown or expired token `404 {"error":"invalid token"}`; a store error `503 {"error":"unavailable"}`. Every answer has `cache-control: no-store` and `x-pulse-contract: 1`, and none holds an address or a token.
- Every valid subscribe request gets the same `202` at once, also when the address is known, in cooldown (10 minutes), at its 3 confirmation mails, or at a limit: `PULSE_NOTIFY_SUBSCRIPTIONS_MAX` rows, `PULSE_NOTIFY_SUBSCRIPTIONS_MAX_PENDING` pending rows, `PULSE_NOTIFY_SUBSCRIPTIONS_CONFIRM_PER_HOUR` mails in a sliding hour, or 100 queued confirmation mails. The decision never waits for SMTP.
- Confirmation mails are sent from an in-memory queue of at most 100 jobs, one attempt at a time, at most 3 attempts per job with the `PULSE_NOTIFY_RETRY_DELAY_MS` backoff. An unsubscribe, a confirm, a new link or cleanup removes the row's queued job at once; an attempt already in flight is not aborted. Queued jobs are lost at shutdown; the visitor asks again.
- At most one subscriber email per mailbox is in flight at any moment. A job for a busy mailbox waits and other mailboxes go on.
- Incident mail: after the channels, each poll whose manual incident read answered (not a 404) stores new public manual incident events in the store, and only then counts `pulse_notify_subscriber_detections_total`. The first such read stores the visible events as seeded and sends nothing. Only the public feed is read, never `/admin`, so drafts, draft updates, notes and internal incidents are never mailed; automatic incidents, reminders and warnings are not mailed either.
- A confirmed subscription gets an event when it was confirmed at or before notify detected the event. One worker sends one event at a time, oldest first, to each eligible subscription, read in pages of 100 ids. The row is read again right before each send, so an unsubscribe answered before the send starts stops it. A send in flight is not aborted; when it settles after a delete, it writes nothing.
- Each pass over an event counts at once and is stored, so a restart never resets it. After `PULSE_NOTIFY_RETRY_ATTEMPTS` passes (12 when that is 0), the subscriptions still without a delivery are marked failed and the next event starts. Between passes the worker waits the `PULSE_NOTIFY_RETRY_DELAY_MS` backoff; after a restart it waits only the rest. A `5xx` refusal fails a delivery at once. Delivery is at least once: a crash after the mail server took a message and before the progress write sends it again with the same `Message-ID`.
- Stop aborts the wait and the send in flight; the event stays pending and the next start goes on with it. Subscriber mail never enters the ledger, the channel deliveries or `failed list|resend`.
- With subscriptions on, `/metrics` adds `pulse_notify_subscribers{state}`, `pulse_notify_subscriber_events_pending`, `pulse_notify_subscriber_detections_total`, `pulse_notify_subscriber_mails_total{kind,outcome}`, `pulse_notify_subscriber_confirmations_queued`, `pulse_notify_subscription_requests_total{route,outcome}` and `pulse_notify_subscription_limited_total{limit}`. With subscriptions off, `/metrics` is unchanged.
- Backups: the store holds addresses and is personal data; it lives on the notify data volume only. Back it up like the ledger (stop pulse-notify, copy `<store>`), keep the backups protected like the notify data volume, for a stated time, and delete them after it. A delete does not remove copies in backups. Restoring an old copy brings back rows that later unsubscribed.
- Key rotation: a new `PULSE_NOTIFY_SUBSCRIPTIONS_KEY_FILE` breaks the unsubscribe link of every mail already sent. Keep the key. A visitor with a broken link asks the contact, and you run `subscribers delete`.

### Known limits of email subscriptions

- D-R1 Delivery is at least once: a crash after the mail server took a message and before the progress write sends it again, with the same `Message-ID`.
- D-R2 An incident event that left the bounded manual incident feed while notify was down is never seen and never mailed.
- D-R3 Subscriber events are sent one by one; an SMTP outage delays later events.
- D-R4 Rate limits are per process and start empty after a restart.
- D-R5 A confirmation mail that was queued but not sent when notify stopped is lost; the visitor can ask again after 10 minutes.
- D-R6 Eligibility uses notify's clock only.
- D-R7 The store file holds addresses. It belongs to the notify data backup and must be protected like it. Losing it drops all subscriptions; restoring an old copy brings back rows that later unsubscribed (their old unsubscribe links still work).
- D-R8 A new HMAC key breaks the unsubscribe links of every delivered mail. Turning subscriptions off keeps the store; turning them on again resumes with the same rows and baseline.
- D-R9 There is no per-requester limit; a flood can fill the hourly confirmation window and delay real confirmation mails for up to an hour.
- D-R10 Root hosting only: the status page must be at the root of its origin.
- D-R11 Copies outside the live store (backups, mailboxes, SMTP provider logs, unsent WAL frames before a checkpoint) are not removed by a delete.
- D-R12 At status, every valid subscribe answer arrives 2 s after the submit, and while 256 subscribe requests are admitted (body being read for at most 5 s, or the answer waiting 2 s), every further subscribe request gets the busy page.
- D-R13 The one-send-per-mailbox bound holds inside one notify process and its store; it does not cover the operator email channel or a second notify with another store.
- Data inventory in memory: the address and tokens of a queued confirmation job (at most 100 jobs, removed at once with its row, a new link, a confirm, expiry or restart), the address of at most one send attempt in flight per mailbox (at most 60 s), and its keyed digest in the send guard (the key is random per process and never stored). An attempt that already started when a delete is answered is not aborted; its email can still arrive, but it writes no delivery row.

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
| `info`  | `resend command admitted`                                           | `command`, `channel`, `state`                                                                                   |
| `warn`  | `resend claim failed, the next poll retries`                        | `error`, `code`, `cause`                                                                                        |
| `warn`  | `resend result post failed, the next poll retries`                  | `command`, `error`, `code`, `cause`                                                                             |
| `warn`  | `resend result refused by the api`                                  | `command`, `state`, `postedState`                                                                               |
| `error` | `resend admission failed`                                           | `command`, `error`, `code`, `cause`                                                                             |
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

From a version with a SQLite state file of format 4:

- The first start migrates the file to format 5 and keeps the checkpointed original as `<state>.v4.bak` (mode `0600`, logged as `ledger migrated` with `from: 4`). Every entry, mark and alert row is kept. A later start does not migrate again.
- Downgrade to a format-4 version: stop, restore `<state>.v4.bak` to `<state>`, remove `<state>-wal` and `<state>-shm`. A format-4 version refuses a format-5 file. Events settled and resend commands handled after the migration are lost and may be sent again.

From a version with a SQLite state file of format 3:

- The first start migrates the file to format 5 and keeps the checkpointed original as `<state>.v3.bak` (mode `0600`, logged as `ledger migrated` with `from: 3`). A later start does not migrate again.
- Downgrade to a format-3 version: stop, restore `<state>.v3.bak` to `<state>`, remove `<state>-wal` and `<state>-shm`. A format-3 version refuses a format-5 file. Events settled after the migration may then be sent again, and the alert state is lost.

From a version with a JSON state file (format 1 or 2):

- The first start migrates the file to SQLite format 5 and keeps the original as `<state>.v<N>.bak` (logged as `ledger migrated`). Statuses, times, payloads and marks are kept. A later start does not migrate again.
- Routing filters are stored from the first poll after the upgrade on. A filter widening made in the same restart as the upgrade sends the history of the newly routed checks once. Upgrade first, then change filters in a later restart, see [channels.md](channels.md#routing).
- Backup now needs a stopped service, see [State: the delivery ledger](#state-the-delivery-ledger).
- Downgrade to a JSON version: stop, restore the backup that the `ledger migrated` log line names as `backup` to `<state>` (`<state>.v1.bak` if the migration was from format 1, `<state>.v2.bak` if from format 2), remove `<state>-wal` and `<state>-shm`. Events settled after the migration may then be sent again.
