# pulse-notify documentation

pulse-notify polls [pulse-api](https://github.com/lorenzh/pulse-api/blob/main/docs/index.md) and sends a notification to each configured channel when an incident opens or resolves.

- [install.md](install.md): run it with npm or Docker.
- [configuration.md](configuration.md): environment variables and the channel config file.
- [channels.md](channels.md): channel types, routing (include, pattern, exclude), reminders, secrets, the payload, delivery and retries.
- [channels/webhook.md](channels/webhook.md), [channels/file.md](channels/file.md), [channels/slack.md](channels/slack.md), [channels/teams.md](channels/teams.md), [channels/email.md](channels/email.md): one page per channel with a config example and a sample message.
- [operation.md](operation.md): the delivery ledger, restarts and logs.
- [troubleshooting.md](troubleshooting.md): error messages, their causes and actions.
- [development.md](development.md): work on pulse-notify itself.

Related pages in other repositories:

- [Incidents and quorum](https://github.com/lorenzh/pulse-api/blob/main/docs/concepts.md#quorum-and-incidents): when pulse-api opens and resolves an incident.
- [REST API](https://github.com/lorenzh/pulse-api/blob/main/docs/rest-api.md): the `GET /incidents` and `GET /checks` endpoints that pulse-notify reads.
