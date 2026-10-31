# Development

Repo-specific points only. The cross-repo view is in the meta repository: [architecture](https://github.com/lorenzh/pulse-meta/blob/main/docs/architecture.md) and [factory](https://github.com/lorenzh/pulse-meta/blob/main/docs/factory.md). The rules for agents and contributors are in [AGENTS.md](../AGENTS.md).

## Run and test

```sh
bun install --frozen-lockfile              # install, also the Lefthook pre-commit hook
PULSE_NOTIFY_CONFIG=./notify.json bun run start
bun run check                           # lint, typecheck and tests
bun test test/<name>.test.ts             # one test file
```

- Tests are in `test/`, with helpers in `test/support.ts` (a local fake API server). They use fake senders or a local server on `127.0.0.1`, never a real webhook or mail server.
- Follow TDD: write the failing test first. Inject `sleep`, `schedule` and `fetch`; use no real clock or network.
- `bun test` requires 80 % line coverage.

## Code map

- `src/index.ts`: entry point and wiring; reads the settings.
- `src/config.ts`: settings and channel config parsing.
- `src/notifier.ts`: poll loop; wires channels.
- `src/detector.ts`: which events are new.
- `src/delivery.ts`: per-channel queue, retries.
- `src/ledger.ts`: the state file.
- `src/channels/webhook.ts`, `src/channels/file.ts`: senders.
- `src/api.ts`, `src/timeout.ts`, `src/metrics.ts`, `src/types.ts`.
- Logging, the health and metrics listener, shutdown, env readers and `formatDuration` come from `@lorenzh/pulse-kit`, not from local copies.

## Lint and hooks

- `bun run lint` runs Biome, SonarJS through ESLint (cognitive complexity of 15 or less per function), and `pulse-workflows` from pulse-config: every action in `.github/workflows` is pinned to an approved SHA, every checkout sets `persist-credentials: false`, and the `uses:` refs of pulse-config equal the `package.json` pin. `bun run format` applies Biome fixes.
- Lefthook runs two pre-commit commands on staged files: `biome check`, and `pulse-eslint` (the same ESLint config as `bun run lint`: SonarJS plus the type-aware `no-floating-promises`, `no-misused-promises` and `switch-exhaustiveness-check` rules).
- The shared Biome, TypeScript, Lefthook, ESLint and CI configuration lives in [pulse-config](https://github.com/lorenzh/pulse-config). Change a rule there, then update the pin here: `package.json` (with `bun.lock`) and both `uses:` refs in `.github/workflows/ci.yml` (`check.yml` and `release.yml`) carry the same SHA. CI runs the shared `check.yml` and builds the image on amd64 and arm64 (`docker` job). The `docker` job runs the step `Image ignores dotenv files` (`bash scripts/image-dotenv.sh pulse-notify:local`): the image must start and pass its own healthcheck with a `.env`, `.env.production` or `.env.local` mounted into `/app`, and its `Cmd` and healthcheck must use `--no-env-file`. Run it locally after `docker build --tag pulse-notify:local .`; on a tag it also runs the `release` job (see [Releasing](#releasing)).
- The pulse-contract dependency is pinned to a commit SHA. Types are imported with `import type` only.

## Releasing

A person releases notify by pushing a SemVer tag. CI then publishes the image `ghcr.io/lorenzh/pulse-notify` for linux/amd64 and linux/arm64 with a build provenance attestation. The release job calls the shared `release.yml` of [pulse-config](https://github.com/lorenzh/pulse-config#releasing-images).

```sh
git tag vX.Y.Z <sha on main> && git push origin vX.Y.Z
```

- A tag is `vX.Y.Z` or `vX.Y.Z-<pre-release>` (for example `v0.1.0`, `v0.2.0-rc.1`). No leading zeros and no `+build` part. Any other tag fails the release before a build.
- A stable tag must point to a commit on `main`. A pre-release tag may point anywhere.
- Gate: the `release` job runs only on a tag, after `check` (lint, typecheck, test) and both `docker` legs (`ubuntu-24.04` and `ubuntu-24.04-arm`) passed. A failed, cancelled or skipped gate skips the release.
- Image tags: `X.Y.Z` always. `X.Y` and `X` only when the version is the highest stable `vX.Y.*` or `vX.*.*` tag. A pre-release gets only its own tag. There is no `latest` and no `edge` tag. A push to `main` or a pull request publishes nothing.
- Never move a release tag. The workflow refuses to publish a version that already exists; push a new version instead.
- The release builds the image again from the tagged commit. The content matches the image the gate checked; the digest can differ.
- Verify a release:

  ```sh
  gh attestation verify oci://ghcr.io/lorenzh/pulse-notify:<version> --owner lorenzh
  ```

- Setups pin an exact version by digest, for example `ghcr.io/lorenzh/pulse-notify:0.1.0@sha256:<digest>`.
