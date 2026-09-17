# AGENTS.md

Instructions for coding agents working on **built-in-ai-observability** — an OpenTelemetry instrumentation monorepo for browser Web AI APIs (Prompt API / `LanguageModel`).

## Project overview

- **Package manager:** pnpm 10 (see `packageManager` in root `package.json`)
- **Build orchestration:** Turborepo (`turbo run <task>`)
- **Lint/format:** Biome via Ultracite rules (`biome.jsonc`)
- **Tests:** Vitest
- **Workspace layout:**
  - `packages/*` — libraries (`@web-ai-otel/core`, instrumentation, SDK, extension transport)
  - `apps/*` — playground and Chrome DevTools extension
  - `examples/*` — minimal consumer apps

Human-facing docs live in `README.md`. Design decisions are in `docs/implementation-proposal.md`.

## Setup commands

```bash
pnpm install          # install all workspace deps
pnpm build            # build all packages and apps
pnpm typecheck        # tsc --noEmit across the monorepo
pnpm test             # vitest in packages that define tests
pnpm check            # biome lint + format check
pnpm format           # auto-fix lint and formatting
pnpm dev              # watch mode (packages)
```

Run all commands from the repository root unless working inside a single package.

## Dependency management

Shared dependency versions are centralized in **`pnpm-workspace.yaml`** under the `catalog:` key. Individual `package.json` files reference them with `"catalog:"`:

```json
{
  "devDependencies": {
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```

**Rules for agents:**

1. **Do not** duplicate version strings across `package.json` files — update the catalog instead.
2. **Do** keep each dependency declared in the package that uses it (Turborepo needs explicit per-package deps).
3. **Do** add new shared deps to the catalog in `pnpm-workspace.yaml` and reference them as `"catalog:"`.
4. Root `package.json` is for repo-wide tooling only (`turbo`, `biome`, `typescript`, etc.) — not app/library runtime deps.
5. Internal packages use `"workspace:*"` (e.g. `"@web-ai-otel/core": "workspace:*"`).

Turborepo orchestrates tasks and caching; it does **not** manage dependency versions. Version centralization is a pnpm catalog concern.

## Upgrading dependencies

Follow this workflow when bumping dependencies.

### 1. Check what is outdated

```bash
pnpm outdated -r
```

### 2. Update the catalog (preferred)

Edit the version in `pnpm-workspace.yaml`:

```yaml
catalog:
  typescript: ^5.10.0   # bump here
  vitest: ^3.3.0
```

Then reinstall:

```bash
pnpm install
```

To upgrade a single catalog entry via CLI:

```bash
pnpm update -r --latest typescript
```

If pnpm warns that a catalog entry already exists, edit `pnpm-workspace.yaml` directly or use `pnpm update` as above — do not add duplicate version strings to individual `package.json` files.

### 3. Upgrade all dependencies (full bump)

```bash
pnpm update -r --latest
```

Review changes to `pnpm-workspace.yaml`, `pnpm-lock.yaml`, and any resolved catalog versions. Fix breaking changes before finishing.

### 4. Add a new shared dependency

1. Add the version to `catalog:` in `pnpm-workspace.yaml`.
2. Add `"<package>": "catalog:"` to the relevant package's `dependencies` or `devDependencies`.
3. Run `pnpm install`.

```bash
# Example: add a dep to one package
pnpm add some-package --filter @web-ai-otel/core
# Then ensure the version in package.json is "catalog:" and the catalog entry exists
```

### 5. Validate after every upgrade

Run the full validation suite and fix any failures before completing the task:

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm check
```

One-liner:

```bash
pnpm install && pnpm build && pnpm typecheck && pnpm test && pnpm check
```

### 6. Manual smoke tests (when runtime behavior may change)

```bash
# Playground
pnpm --filter @web-ai-otel/playground dev

# Vanilla example
pnpm --filter @web-ai-otel/example-vanilla dev

# DevTools extension
pnpm --filter @web-ai-otel/devtools-extension build
# Load apps/devtools-extension/dist as an unpacked Chrome extension
```

## Running tasks for a single package

```bash
pnpm --filter @web-ai-otel/core build
pnpm --filter @web-ai-otel/core test
pnpm --filter @web-ai-otel/devtools-extension typecheck
```

Package names are in each `package.json` `name` field (e.g. `@web-ai-otel/core`, not the directory name).

Turborepo filters:

```bash
turbo run build --filter=@web-ai-otel/core
turbo run test --filter=@web-ai-otel/instrumentation-prompt-api
turbo run build --affected   # only changed packages + dependents
```

## Testing instructions

- Tests live next to source as `*.test.ts` under each package's `test/` directory.
- `pnpm test` runs vitest via Turbo; packages without tests are skipped.
- `@web-ai-otel/sdk-browser` uses `vitest run --passWithNoTests`.
- After code changes, run tests for the affected package at minimum; prefer the full `pnpm test` before finishing.

Run a single test file or pattern from a package directory:

```bash
cd packages/core
pnpm vitest run test/tools.test.ts
pnpm vitest run -t "specific test name"
```

## Code style

- TypeScript strict mode; ESM (`"type": "module"` in library packages).
- Formatting and lint rules are enforced by Biome (`pnpm check` / `pnpm format`).
- Match existing patterns in the file you edit — naming, imports, test style.
- Ambient Prompt API types live in `types/prompt-api.d.ts` (shared, not `@types/dom-chromium-ai`).
- Keep changes minimal and scoped; do not refactor unrelated code.

## Commit and PR guidelines

- Do not create commits unless explicitly asked.
- Do not push unless explicitly asked.
- After dependency upgrades, the commit should include `pnpm-workspace.yaml`, `pnpm-lock.yaml`, and any `package.json` changes.
- Suggested commit message style: `chore(deps): bump <package> to <version>` or `chore(deps): upgrade dependencies`.

## Common pitfalls

- **Repeating versions in package.json** — always use `catalog:` for shared deps.
- **Installing app deps at the root** — install in the package that uses them.
- **Skipping `pnpm install` after catalog edits** — lockfile must be updated.
- **Using `turbo build` in scripts** — use `turbo run build` in `package.json` and CI.
- **OpenTelemetry version skew** — keep `@opentelemetry/*` packages on compatible versions; bump them together in the catalog.
