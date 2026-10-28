# pulse-notify

[![CI](https://github.com/lorenzh/pulse-notify/actions/workflows/ci.yml/badge.svg)](https://github.com/lorenzh/pulse-notify/actions/workflows/ci.yml)

pulse is an uptime monitor with a status page. This repository is its notifier: it will send incident notifications to configured channels when an incident opens or resolves.

pulse-notify will depend on [pulse-contract](https://github.com/lorenzh/pulse-contract) for its shared types and talk to [pulse-api](https://github.com/lorenzh/pulse-api) at run time. Neither is wired up yet.

pulse is built by Paragon Factory agents from the issues in [pulse-meta](https://github.com/lorenzh/pulse-meta).

## Install

Requires Node 24 or newer.

```sh
npm ci
```

## Development

```sh
npm run check   # lint, typecheck and tests
npm test        # tests only
npm run lint    # Biome format and lint check, changes nothing
npm run format  # Biome: apply formatting and safe lint fixes
```

`npm ci` installs a Lefthook pre-commit hook that runs `biome check` on the staged files and rejects the commit if they are badly formatted or fail lint. Run `npm run format` to fix them.
