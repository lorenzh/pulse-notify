# AGENTS.md

Instructions for coding agents in this repository. They bind every change.

## Project

pulse is an uptime monitor with a status page, split over several repositories. Work arrives as an
issue with an approved spec from the meta repository; implement only the section for this
repository. Node 24+ with native type stripping, ESM, npm, strict TypeScript (`tsc --noEmit`),
`node:test`, Biome, Lefthook.

## Commands

| Task                                                          | Command                                    |
| ------------------------------------------------------------- | ------------------------------------------ |
| Install from the lockfile (also installs the pre-commit hook) | `npm ci`                                   |
| All checks: CI runs the same steps                            | `npm run check`                            |
| One test file                                                 | `node --test src/<name>.test.ts`           |
| Tests whose name matches                                      | `node --test --test-name-pattern "<text>"` |
| Typecheck                                                     | `npm run typecheck`                        |
| Lint and format check / apply fixes                           | `npm run lint` / `npm run format`          |
- A change is done when `npm run check` passes; the pre-commit hook runs only Biome. Never run `git commit --no-verify`, and never weaken the shared config (`biome.json`, `tsconfig.json`, CI) to pass.

## Repository boundaries

- `pulse-contract` holds shared types only. It has no runtime code and depends on no other repo.
- Import contract types with `import type` only. A service never imports another service.
- Services talk to each other only over HTTP at run time, in the shapes the contract defines.
- Pin the contract dependency to a full commit SHA on its `main`; update the pin when the spec needs a newer contract.
- A change that needs a contract change waits for the merged contract change. Never copy contract types into a service.
- Edit only this repository. Other repositories in the workspace are read-only context.
- Do not add `.factory/`, plan, or note files to this repository.

## TypeScript

- The source runs unbuilt under Node type stripping: erasable syntax only (no `enum`, `namespace`, parameter properties). Use string-literal unions or `as const` objects.
- Relative imports carry the `.ts` extension. Built-ins use the `node:` prefix.
- Type-only imports use `import type`; mixed imports mark types inline: `import { type X, y }`.
- No `any`, also not in tests. Use `unknown` and narrow it, or the contract type.
- No non-null `!` in `src/` code. Check for `undefined` instead.
- Use `as` only right after a check at a trust boundary, never to silence the compiler.
- Give exported functions explicit return types. Use exhaustive `switch` over unions with a `never` default.
- Named exports only. No barrel files and no generic `utils.ts`.

## Code design

- One module, one responsibility. Name the module after its job (`scheduler.ts`, `uptime.ts`).
- Split a module when it holds a second responsibility, not because it is long. Over 200 lines is a review question, not a limit.
- Keep a helper beside its only caller; move it out when a second module needs it.
- Keep logic pure. I/O (HTTP, SQLite, files, `process.env`, `console`) stays in `main.ts` and the server or client modules.
- Pass side effects in as dependencies: `now: () => number`, `fetch`, `setTimeout`/`sleep`, `log`. Only `main.ts` wires the real ones.
- Validate untrusted input at the edge: request bodies, config files, env, and JSON from another service. Inside, use the parsed type.
- Name a function by its effect (`postResult`, `applyResult`); a pure query reads as a noun or question (`quorumStatus`, `isStale`).
- Booleans start with `is`, `has`, or `can`. Files are kebab-case.

## Errors

- Throw only `Error` subclasses with a `name`. Wrap with `{ cause }` instead of losing the original.
- An expected failure the caller must handle (bad input, unknown id) is a typed error or a result value.
- Catch at the boundary: the HTTP handler maps errors to a status and an `ErrorResponse`; `main.ts` logs and exits.
- Never swallow an error silently. A deliberate ignore has a one-line comment that says why.
- Error and log text never contains secrets or full config.

## Tests (TDD)

- Red, green, refactor: write the failing test, watch it fail for the expected reason, write the smallest code that passes, then clean up.
- A bug fix starts with a test that reproduces the bug.
- Test the main behavior, the spec's acceptance criteria, and the obvious failures (invalid input, unreachable service, timeout). Skip contrived edge cases.
- Tests sit next to the code as `src/<module>.test.ts`; split a large suite by topic (`service.quorum.test.ts`).
- Test through exported functions and HTTP, not private details. Do not export a function only for a test.
- Use hand-written fakes passed as dependencies. Do not mock Node modules or globals.
- No real clock and no real timers: inject `now` and a fake `setTimeout`, and advance them in the test.
- No external network. Start servers on `127.0.0.1` port `0` inside the test and close them in `after`.
- Each test writes only to its own `mkdtemp` directory or an in-memory database, and cleans it up.
- `npm test` enforces at least 80 % line coverage and `npm run lint` limits cognitive complexity to 15 per function (SonarJS); never lower either to pass.

## End-to-end checks

- Each service has at least one test that starts its real server on port `0` and drives it over HTTP, with fake peers for other services.
- A change to an endpoint or a response shape gets such a test, with the response typed by the contract.
- Before handoff of a user-visible change, start the service with `npm start` and exercise the changed behavior once; report the command and result.

## Documentation

- `README.md` owns what the repository does, how to run it, its settings (env vars and defaults), and its HTTP endpoints or types.
- Update `README.md` in the same change when behavior, a setting, an endpoint, or a type changes.
- `AGENTS.md` owns commands and conventions. Update it when a command or a convention changes.
- Specs and feature history live in the meta repository, not here.
- Comment only what the code cannot say: a non-obvious order, why the obvious way is wrong, a known limit, an external rule. No commented-out code.
- Write docs and comments in English, in short plain sentences.

## Commits and pull requests

- One change per pull request, limited to the issue's spec section.
- Commit subjects use Conventional Commits, imperative, lower case, no period (`fix: keep last data when the api is down`).
- The pull request names the issue, the checks that ran, and the known limits.

## This repository

- Entry point and wiring: `src/index.ts` (`npm start` runs `node src/index.ts`). It reads the settings in `src/config.ts` (`PULSE_NOTIFY_CONFIG` is required; other variables and defaults are in `README.md`).
- Channels are sender functions in `src/channels/` (`webhook.ts`, `file.ts`), created by `createWebhookSender` and `createFileSender` and wired in `src/notifier.ts`. Channel config types are in `src/types.ts`.
- `src/delivery.ts` takes `send`, `sleep`, and `ledger` as injected dependencies.
- Tests live in `test/`, not next to the code, with helpers in `test/support.ts` (a local fake API server). They use fake senders or a local server on `127.0.0.1`, never a real webhook or mail server.

## Shared tooling configuration

The shared tooling configuration lives in `lorenzh/pulse-config`. The other pulse repositories use it through `extends` (Biome, TypeScript, Lefthook), a one-line ESLint config and `uses:` (CI). A rule change is made in `pulse-config` and reaches a target when its pin is updated. "Never weaken `biome.json`, `tsconfig.json` or CI" refers to the shared config.
