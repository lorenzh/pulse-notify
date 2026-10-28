# AGENTS.md

## Commands

```sh
npm ci           # install from the lockfile
npm run check    # lint, typecheck, then tests (line coverage >= 80 %)
npm run lint     # Biome check, then SonarJS via ESLint (cognitive complexity <= 15)
npm run format   # Biome: apply formatting and safe fixes
```

A Lefthook pre-commit hook (installed by `npm ci` via `prepare`) runs `biome check` and ESLint (SonarJS, config in `tools/sonarjs/`) on staged files and blocks the commit on failures.

## Conventions

- SonarJS tooling lives in the `tools/sonarjs` npm workspace (it needs the TypeScript 6 JS API; the root keeps TypeScript 7). `.npmrc` sets `install-strategy=nested` so each copy resolves its own TypeScript.

- Strict TypeScript, ESM, Node 24 type stripping (erasable syntax only).
- Every change gets tests with `node:test`, next to the code they cover.
- Time-dependent logic takes an injectable clock. Tests never use real timers.
- Network tests run only against local servers started inside the test.
