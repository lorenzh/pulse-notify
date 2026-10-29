# pulse-notify documentation

pulse-notify polls [pulse-api](https://github.com/lorenzh/pulse-api/blob/main/docs/index.md) and sends a notification to each configured channel when an incident opens or resolves.

- [install.md](install.md): run it with npm or Docker.
- [configuration.md](configuration.md): environment variables and the channel config file.
- [channels.md](channels.md): the `webhook` and `file` channels, the payload, delivery and retries.
- [operation.md](operation.md): the delivery ledger, restarts and logs.
- [troubleshooting.md](troubleshooting.md): error messages, their causes and actions.
- [development.md](development.md): work on pulse-notify itself.

Related pages in other repositories:

- [Incidents and quorum](https://github.com/lorenzh/pulse-api/blob/main/docs/concepts.md#quorum-and-incidents): when pulse-api opens and resolves an incident.
- [REST API](https://github.com/lorenzh/pulse-api/blob/main/docs/rest-api.md): the `GET /incidents` and `GET /checks` endpoints that pulse-notify reads.
