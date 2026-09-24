# AGENTS.md

Instructions for coding agents working on **built-in-ai-observability** — an observability monorepo for browser Built-in AI APIs (Prompt API / `LanguageModel`), exporting OpenTelemetry spans.

## Project overview

- **Node.js:** 22.18+, 24.11+, or 26+ at build time (see `engines` in root `package.json` and `.nvmrc`; required by `tsdown`)
- **Package manager:** pnpm 12 (see `packageManager` in root `package.json`)
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
pnpm check            # biome lint + format check (full repo)
pnpm format           # auto-fix lint and formatting (full repo)
pnpm precommit        # run git pre-commit hook manually (Lefthook → Biome on staged files)
pnpm dev              # watch mode (packages)
```

Run all commands from the repository root unless working inside a single package.

Git **pre-commit** hooks (via [Lefthook](https://lefthook.dev/)) run Biome on **staged** files — see `lefthook.yml`. Hooks install on `pnpm install` (`prepare` script). Run manually with `pnpm precommit`. Bypass only when intentional: `git commit --no-verify`.

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

### 4. pnpm 12 workspace settings

`pnpm-workspace.yaml` also configures:

- `minimumReleaseAge: 0` — allow freshly published packages (early-stage repo)
- `allowBuilds.esbuild: true` — required for Vite native binaries
- `allowBuilds.lefthook: true` — required for Lefthook’s postinstall binary download
- `catalog:` — shared dependency versions (see above)

### 5. Add a new shared dependency

1. Add the version to `catalog:` in `pnpm-workspace.yaml`.
2. Add `"<package>": "catalog:"` to the relevant package's `dependencies` or `devDependencies`.
3. Run `pnpm install`.

```bash
# Example: add a dep to one package
pnpm add some-package --filter @web-ai-otel/core
# Then ensure the version in package.json is "catalog:" and the catalog entry exists
```

Library packages use **tsdown** for bundling and DTS generation (TypeScript 7 compatible). Requires **Node.js 22.18+** at build time — the bundled output is not locked to that runtime.

### 6. Validate after every upgrade

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

### 7. Manual smoke tests (when runtime behavior may change)

```bash
pnpm dev:playground    # playground (Vite)
pnpm dev:vanilla       # vanilla example
pnpm build:extension   # then load apps/devtools-extension/dist in Chrome
pnpm mlflow            # optional: local trace UI at http://localhost:5000/?experiment=0
```

## Running tasks for a single package

Prefer root scripts when available:

| Script | Package |
| --- | --- |
| `pnpm dev:playground` | `@web-ai-otel/playground` |
| `pnpm build:playground` | `@web-ai-otel/playground` |
| `pnpm dev:vanilla` | `@web-ai-otel/example-vanilla` |
| `pnpm build:vanilla` | `@web-ai-otel/example-vanilla` |
| `pnpm dev:extension` | `@web-ai-otel/devtools-extension` |
| `pnpm build:extension` | `@web-ai-otel/devtools-extension` |

For other packages, use Turborepo filters:

```bash
turbo run build --filter=@web-ai-otel/core
turbo run test --filter=@web-ai-otel/instrumentation-prompt-api
turbo run build --affected   # only changed packages + dependents
```

Or `pnpm --filter <package-name> <script>` when a root alias does not exist.

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
