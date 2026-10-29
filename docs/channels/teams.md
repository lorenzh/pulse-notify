# Microsoft Teams channel

Posts an Adaptive Card to a Teams Workflows webhook URL.

```json
{
  "id": "teams-ops",
  "type": "teams",
  "urlFile": "/run/secrets/teams-url",
  "statusUrl": "https://status.example.com"
}
```

The keys are the same as for [Slack](slack.md): `urlEnv` or `urlFile` (one of them), `statusUrl`, `hideReason`, and the common keys.

- The URL must be `https:` (loopback `http:` is allowed for tests).
- The body is a `message` with one Adaptive Card attachment, the format that the Workflows ("When a Teams webhook request is received") URL accepts. The retired Office 365 connector card (`MessageCard`) is not used.
- Markdown characters in the check name and reason are escaped with a backslash.
- Any 2xx status is success; Teams often answers `202`. Other statuses and redirects are failures that are retried.

Sample message (rendered card):

```text
DOWN: Example site
Reason: HTTP 503
Time: 2026-01-01T12:00:00.000Z
[Status page]   (only when statusUrl is set)
```
