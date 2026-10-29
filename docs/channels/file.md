# File channel

```json
{ "id": "log", "type": "file", "path": "./incidents.jsonl" }
```

In Docker, only `/data` is writable: use `"path": "/data/incidents.jsonl"`.

- Appends the [payload](../channels.md#payload) as one JSON line to `path`. The parent directory is created.
- The file is never truncated or rotated by pulse-notify.
- A write error is a failed attempt and is retried like any other.
- `reminder` lines appear only when `remindEverySeconds` is set on the channel.

Sample line:

```text
{"key":"12:opened","event":"opened","incidentId":12,"checkId":"example","checkName":"Example site","reason":"HTTP 503","time":"2026-01-01T12:00:00.000Z","timeMs":1767268800000,"openedMs":1767268800000}
```
