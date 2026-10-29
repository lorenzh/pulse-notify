# Email channel

Sends a plain text email over SMTP. pulse-notify sends it with [nodemailer](https://nodemailer.com), its only SMTP and MIME library. It makes one connection per attempt and closes it after the attempt.

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
- `PULSE_NOTIFY_TIMEOUT_MS` covers one whole attempt, from the connection to the end of the send, as one shared deadline. A slow server that answers each command in time can still hit it. The timeout message does not name a stage (`SMTP send timed out after <ms>ms`). A timeout and an abort are retried.
- Any failed reply fails the attempt. A 5xx reply, at any stage (greeting, `STARTTLS`, `AUTH`, `MAIL FROM`, `RCPT TO`, `DATA`, end of data), is a [permanent error](../channels.md#delivery-and-retries): the event is `failed` at once. A 4xx reply is retried like a webhook failure. The reply code decides. Error text holds only fixed words and the code, never text from the server.
- Login uses `AUTH PLAIN` or `AUTH LOGIN`. `CRAM-MD5` and `XOAUTH2` are never used; a server that offers neither `PLAIN` nor `LOGIN` fails the attempt.
- If some recipients are refused and others accepted, the message is still sent to the accepted ones and the attempt fails, so a retry can deliver a second copy to them.
- Limits on the size of server replies are those of nodemailer.
- `Message-ID` is `<hash-of-key@domain-of-from>`, so a resend after a crash carries the same ID and a receiver can drop the duplicate.
- The body is UTF-8 plain text. A subject with non-ASCII text is encoded as RFC 2047 by nodemailer.

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
