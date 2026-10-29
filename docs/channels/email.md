# Email channel

Sends a plain text email over SMTP. pulse-notify has its own small SMTP client (`EHLO`, `STARTTLS`, `AUTH PLAIN` and `LOGIN`, `MAIL FROM`, `RCPT TO`, `DATA`, `QUIT`), so there is no extra dependency.

```json
{
  "id": "mail-ops",
  "type": "email",
  "smtp": {
    "host": "smtp.example.com",
    "port": 587,
    "tls": "starttls",
    "username": "pulse",
    "passwordEnv": "SMTP_PASSWORD"
  },
  "from": "Pulse <pulse@example.com>",
  "to": ["ops@example.com"],
  "subjectPrefix": "[pulse]",
  "statusUrl": "https://status.example.com"
}
```

| Key                       | Required | Meaning                                                                                                                                                                                                      |
| ------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `smtp.host`, `smtp.port`  | yes      | The mail server.                                                                                                                                                                                             |
| `smtp.tls`                | no       | `starttls` (default), `tls` (implicit TLS) or `none`.                                                                                                                                                        |
| `smtp.clientName`         | no       | Name sent with `EHLO`: a host name or an address literal such as `[192.0.2.1]`, on one line. Default: `PULSE_NOTIFY_SMTP_CLIENT_NAME`, else the machine host name cleaned to a valid name, else `localhost`. |
| `smtp.username`           | no       | Turns on login. Then exactly one of `passwordEnv` or `passwordFile` is required.                                                                                                                             |
| `from`                    | yes      | Address or `Name <address>`.                                                                                                                                                                                 |
| `to`                      | yes      | Non-empty array of addresses.                                                                                                                                                                                |
| `subjectPrefix`           | no       | Text put before the subject.                                                                                                                                                                                 |
| `statusUrl`, `hideReason` | no       | As for [Slack](slack.md).                                                                                                                                                                                    |
- Certificate verification is always on.
- `none` must be set explicitly. Login over `none` to a host other than `127.0.0.1`/`localhost` is refused at startup.
- A line break in `from`, `to` or `subjectPrefix` stops startup. A line break in the check name or reason is replaced by a space.
- `PULSE_NOTIFY_TIMEOUT_MS` covers one whole attempt, from the connection to `QUIT`, as one shared deadline. A slow server that answers each command in time can still hit it.
- Any reply that is not 2xx (or 354 for `DATA`) fails the attempt. A 5xx reply, at any stage (greeting, `EHLO`, `STARTTLS`, `AUTH`, `MAIL FROM`, `RCPT TO`, `DATA`, end of data), is a [permanent error](../channels.md#delivery-and-retries): the event is `failed` at once. A 4xx reply is retried like a webhook failure. The final reply code decides.
- A reply of more than 100 lines, or more than 64 KiB of unread reply lines, fails the attempt as a retryable error.
- Bytes that arrive before the TLS handshake of `STARTTLS` are dropped, so a server or a man in the middle cannot plant replies for the commands after it.
- `Message-ID` is `<hash-of-key@domain-of-from>`, so a resend after a crash carries the same ID and a receiver can drop the duplicate.
- The body is UTF-8 plain text in base64.

Sample message:

```text
Subject: [pulse] DOWN: Example site

Example site is DOWN.

Check: Example site
State: DOWN
Reason: HTTP 503
Time: 2026-01-01T12:00:00.000Z
Status: https://status.example.com
```
