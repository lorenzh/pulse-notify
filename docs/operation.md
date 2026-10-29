# Operation

## State: the delivery ledger

pulse-notify keeps one state file, the delivery ledger. Its path is `PULSE_NOTIFY_STATE` (default `./notify-state.json`; `/data/notify-state.json` in the Docker image).

- One JSON object: `{ "version": 1, "channels": { "<channel id>": { "<key>": "<status>" } } }`.
- Status is `seeded`, `pending`, `delivered` or `failed`.
- The file is rewritten on every change: written to `<path>.tmp`, flushed to disk, then renamed over the ledger. The parent directory is created if missing.
- The ledger is read once at start. Do not edit it while pulse-notify runs.
- A file with a different `version` or no `channels` object stops the process, see [troubleshooting.md](troubleshooting.md).
- The ledger grows by one entry per channel and event. pulse-notify never prunes it.

Backup: copy the file. It is replaced atomically, so a copy is always a whole file. Restoring is putting the file back with pulse-notify stopped. This was not tested as a procedure beyond that.

If you delete the ledger, every channel counts as new on the next start. It records the current incidents as `seeded` and sends nothing for them. If you remove a channel id and add it back later, it is not seeded again: the ledger keeps the channel. The re-added channel receives the incidents from the time it was removed.

## Restart behavior

- The environment and the config file are read at start. To change a channel, a URL or a setting, restart.
- At start, every ledger entry that is still `pending` is logged at error level: `notification possibly lost: claimed but never settled`. A crash between claim and send loses that one notification. It is not sent again.
- Events that were detected but not yet claimed are lost on stop and found again on the next start. `SIGINT` and `SIGTERM` do not drain the queues.
- Events that failed all 4 attempts stay `failed` and are not retried.
- If pulse-api is down, pulse-notify keeps running and polls again on the next tick.

## Logs

Logs are JSON lines on stderr. Each line has `time` (ISO 8601 UTC), `level` (`info`, `warn` or `error`), `msg` and extra fields.

| Level   | `msg`                                                   | Fields                                |
| ------- | ------------------------------------------------------- | ------------------------------------- |
| `info`  | `pulse-notify started`                                  | `channels` (ids), `apiUrl`            |
| `info`  | `channel seeded with existing incidents`                | `channel`, `incidents`                |
| `info`  | `notification delivered`                                | `channel`, `key`, `attempts`          |
| `warn`  | `delivery attempt failed`                               | `channel`, `key`, `attempt`, `error`  |
| `error` | `notification delivery failed`                          | `channel`, `key`, `attempts`, `error` |
| `error` | `notification possibly lost: claimed but never settled` | `channel`, `key`                      |
| `error` | `api poll failed`                                       | `error`                               |

Startup configuration errors are not JSON. They are one line on stderr: `configuration error: <message>`, exit code 2.
