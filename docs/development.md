# Development

Repo-specific points only. The cross-repo view is in the meta repository: [architecture](https://github.com/lorenzh/pulse-meta/blob/main/docs/architecture.md) and [factory](https://github.com/lorenzh/pulse-meta/blob/main/docs/factory.md). The rules for agents and contributors are in [AGENTS.md](../AGENTS.md).

## Run and test

```sh
npm ci                                   # install, also the Lefthook pre-commit hook
PULSE_NOTIFY_CONFIG=./notify.json npm start
npm run check                            # lint, typecheck and tests
node --test test/<name>.test.ts          # one test file
```

- Tests are in `test/`, with helpers in `test/support.ts` (a local fake API server). They use fake senders or a local server on `127.0.0.1`, never a real webhook or mail server.
- Follow TDD: write the failing test first. Inject `sleep`, `schedule` and `fetch`; use no real clock or network.
- `npm test` requires 80 % line coverage.

## Code map

- `src/index.ts`: entry point and wiring; reads the settings.
- `src/config.ts`: settings and channel config parsing.
- `src/notifier.ts`: poll loop; wires channels.
- `src/detector.ts`: which events are new.
- `src/delivery.ts`: per-channel queue, retries.
- `src/ledger.ts`: the state file.
- `src/channels/webhook.ts`, `src/channels/file.ts`: senders.
- `src/api.ts`, `src/timeout.ts`, `src/log.ts`, `src/types.ts`.

## Lint and hooks

- `npm run lint` runs Biome and SonarJS through ESLint (cognitive complexity of 15 or less per function). `npm run format` applies Biome fixes.
- Lefthook runs two pre-commit commands on staged files: `biome check`, and `pulse-eslint` (the same ESLint config as `npm run lint`: SonarJS plus the type-aware `no-floating-promises`, `no-misused-promises` and `switch-exhaustiveness-check` rules).
- The shared Biome, TypeScript, Lefthook, ESLint and CI configuration lives in [pulse-config](https://github.com/lorenzh/pulse-config). Change a rule there, then update the pin here. CI runs the shared `check.yml`.
- The pulse-contract dependency is pinned to a commit SHA. Types are imported with `import type` only.
