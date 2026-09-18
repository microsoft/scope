# Scope

Scope is a platform for benchmarking AI coding agents. It orchestrates multiple coding agents (GitHub Copilot, Claude Code, VS Code Web), sends them standardized tasks through configurable scenarios and personas, evaluates results using a criteria DAG with the Judge service, and tracks everything with real-time logging.

For the full system architecture, see [docs/architecture/overview.md](docs/architecture/overview.md).

## Repository Structure

pnpm workspaces monorepo. TypeScript, strict mode, ES2022, NodeNext modules.

```
apps/
  api/                          # REST API — run orchestration, SSE log streaming, criteria CRUD
  cli/                          # CLI — submit runs, stream logs, manage criteria
  judge/                        # Evaluation engine — scores agent output against criteria DAG
  portal/                       # Web UI — run management, insights, criteria graph editor
  token-manager/                # Token storage, validation, round-robin distribution
  workers/
    coder-acp-copilot/          # GitHub Copilot worker (ACP SDK)
    coder-acp-claude-code/      # Claude Code worker (ACP SDK)
    report-generator/           # Post-run report generation
  model-scanners/               # Feature detection for Copilot and Anthropic models
  version-checkers/             # Poll for new agent/tool releases
  key-updaters/                 # GitHub auth cookie management for VS Code Web
packages/
  shared/                       # Monorepo foundation — types, DB models, queue/blob/redis clients
  db-migrations/                # MongoDB migration framework (mongo-migrate-ts)
  github-auth/                  # GitHub OAuth/device-code auth utilities
  model-scanning/               # Shared model scanning logic
  version-checking/             # Version comparison utilities
  llm-eval/                     # LLM-graded eval harness (grader, sampling, rate-limit retry)
config/                         # Benchmark definitions (YAML)
```

For package architecture and data models, see [docs/architecture/app-design.md](docs/architecture/app-design.md).

## Key Components

### API (`apps/api/`)

Express.js REST server. Orchestrates runs, streams logs via SSE, manages criteria CRUD, routes tasks to workers through Azure Storage Queues. Connects to MongoDB (CosmosDB-compatible), Redis, Azure Storage Queues, and Blob Storage.

> **Project-scoping invariant:** never perform a global, slug-only get/edit/soft-delete on a
> project-scoped entity. Every such query must filter by `_id` **or** `projectId` — a human
> slug/business id is never a key on its own. Derive `projectId` from context (a parent doc or the
> run-request) when available, else require it from the client (`?projectId=`), else fail **400**.
> See the by-id invariant in [docs/architecture/app-design.md](docs/architecture/app-design.md#never-a-global-slug-only-action-on-a-project-scoped-entity-the-by-id-invariant).

- Data models and API design: [docs/architecture/app-design.md](docs/architecture/app-design.md)
- SSE + Change Streams pattern: [docs/research/realtime-data-flow.md](docs/research/realtime-data-flow.md)
- Environment variables: [ENV_VARIABLES.md](ENV_VARIABLES.md)

> **Authentication invariant:** verify the unchanged IdP bearer before any user-access
> cache lookup. Only `POST /api/v1/users/me` calls
> `UserAccessResolver.enrollOnLogin()` for JIT/profile/lastLogin/bootstrap writes.
> Every `GET /users/me` and other routes use `resolveExisting()` (Redis hit: no Mongo;
> miss/outage: exact identity read, never upsert). Missing/disabled identities deny
> access, never become anonymous. Preserve existing no-token/public rollout; full
> RBAC and Scope internal tokens remain deferred. See
> [auth-rbac.md](docs/architecture/auth-rbac.md) before changing this boundary.

### Workers (`apps/workers/`)

Each worker implements the same queue-processor interface but adapts a different coding agent:

| Worker | Agent | Protocol |
|--------|-------|----------|
| `coder-acp-copilot` | GitHub Copilot | ACP SDK v0.14.1 |
| `coder-acp-claude-code` | Claude Code | ACP SDK v0.13.1 |
| `report-generator` | — | Copilot SDK |

Workers consume tasks from Azure Storage Queues (named `queue-<worker-name>`) and write results to MongoDB and Blob Storage. Each has its own Dockerfile and docker-compose profile.

- VS Code Web worker architecture: [docs/architecture/vscode-web-worker.md](docs/architecture/vscode-web-worker.md)
- Skills integration: [docs/architecture/skills.md](docs/architecture/skills.md)

### Judge (`apps/judge/`)

Evaluation engine that scores agent output against a criteria DAG (directed acyclic graph). Uses the GitHub Copilot SDK for LLM-based evaluation. Two strategies: `bundled` (all criteria in one session) or `independent` (topological order, skips descendants of failures).

- CriteriaProvider abstraction: [docs/architecture/criteria-provider.md](docs/architecture/criteria-provider.md)
- Judge configuration variables: [ENV_VARIABLES.md](ENV_VARIABLES.md)

### Portal (`apps/portal/`)

React 19 web UI with Vite, Tailwind CSS, Radix UI (shadcn/ui), TanStack Query, and XYFlow for criteria DAG visualization. Communicates with the API via REST and SSE.

`AuthProvider` owns the Scope-user handshake: callback → `POST /users/me`;
cached-account reload → plain `/users/me`. Gate all eager queries (including
providers outside `RequireAuth`) until ready; do not treat MSAL account claims as
the Scope UUID/role. Deduplicate account/login work and cancel it on account change
or logout. The enrollment POST is no-store and must never be prefetched/polled.

- Real-time data flow: [docs/research/realtime-data-flow.md](docs/research/realtime-data-flow.md)

> **Storybook**: When adding or modifying portal components, update the corresponding Storybook stories. Use the `storybook` skill for guidance.

#### Portal UX v2 implementation learnings (Runs + Submit Run)

Use these patterns when extending list/detail or run-submission UX:

1. **Keep interaction model consistent across entities.**
   - Use the same layout contract: central list/table, right filter rail, contextual left detail/settings panel.
   - Reuse shared list primitives (`ListLayout`, `FilterRail`, `DataTable`, `CustomizeColumnsPanel`, `Pagination`) instead of ad-hoc page layouts.

2. **Prefer in-place creation over navigation breaks.**
   - For `/runs/new`, create profiles in a dialog and keep users on the page.
   - Reuse shared forms (e.g. `ProfileCreateForm`) between full-page and modal flows to avoid behavior drift.

3. **Treat action counts as source-of-truth UX.**
   - Any submit/CTA label must reflect the real backend effect (e.g. expanded run count, not just occurrence count).
   - If composition/expansion is shown elsewhere on the page, the primary action label must match it exactly.

4. **Composition UIs should make hierarchy explicit.**
   - Show base profile and variations with distinct visual semantics (badges/labels such as `Base`, `Var N`).
   - Prefer profile names over IDs in group headers and list cells; use IDs only as fallback.
   - When grouped by profile, carry base/variation badges into group headers for scanability.

5. **Long forms in dialogs require stable action affordances.**
   - Use a constrained scroll container with a sticky footer for primary actions.
   - Ensure dialog structure uses a non-growing shell (`grid-rows-[auto_minmax(0,1fr)]` + `min-h-0`/`overflow-y-auto`) so content scrolls without losing actions.

6. **Inline control rows should align visually and behaviorally.**
   - Keep `New…` actions on the same row as their picker/search control where possible.
   - Match control heights and interaction patterns between similar pickers (task/profile/criteria) to reduce cognitive load.

### CLI (`apps/cli/`)

Command-line interface built with Commander.js and Ink (React for terminals). Used for submitting runs, streaming logs, managing criteria, and CI/CD automation. Run `pnpm cli --help` to discover subcommands.

> **CLI ↔ Portal parity**: Every feature available in the Portal must also be available in the CLI. The CLI is the primary interface for CI/CD and power users — it must never lag behind the Portal in capabilities.

- Distribution and standalone installation: [docs/architecture/cli-distribution.md](docs/architecture/cli-distribution.md)

### Token Manager (`apps/token-manager/`)

Express service for centralized token storage, validation, and round-robin distribution. Integrates with Azure Key Vault (Lowkey Vault locally). Uses `packages/github-auth/` for GitHub OAuth/device-code auth.

- Architecture: [docs/architecture/token-manager.md](docs/architecture/token-manager.md)

### Shared Package (`packages/shared/`)

Monorepo foundation. Exports types (runs, iterations, criteria, scenarios, personas), Mongoose models, and service clients (queue, blob, redis, config loader, criteria-store, criteria-provider). All apps and workers depend on it — breaking changes here affect everything.

- Package dependency graph: [docs/architecture/app-design.md](docs/architecture/app-design.md)
- CriteriaProvider abstraction: [docs/architecture/criteria-provider.md](docs/architecture/criteria-provider.md)

## Configuration (`config/`)

Personas, scenarios (tasks), criteria, and prompt features are stored in **MongoDB** (source of truth). They can be exported/imported as YAML for portability and version control. The `config/` folder contains YAML examples of these data types.

- `traits.yaml` — Evaluation trait dimensions (personality, experience, verbosity, type)
- `personas/` — Reviewer personas combining traits (e.g. `demanding-senior.yaml`, `vibe-coder.yaml`)
- `scenarios/` — Task definitions agents must implement (e.g. `hello-world-express.yaml`, `react-snake-game-v2.yaml`)
- `criteria/` — Evaluation criteria forming a DAG with parent-child dependencies, consumed by the judge
- `prompt-features/` — Feature flags tracking what capabilities agents request

## Database Migrations (`packages/db-migrations/`)

Built on `mongo-migrate-ts`. Migrations are TypeScript files with `up()` and `down()` methods. MongoDB is CosmosDB-compatible — avoid features not supported by CosmosDB's MongoDB API.

- Run: `pnpm migrate:up`, `pnpm migrate:down`, `pnpm migrate:status`
- Framework docs: [docs/architecture/db-migrations.md](docs/architecture/db-migrations.md)

## Development

```bash
pnpm docker:up:infra              # Start backing services (MongoDB, Redis, Azurite, Lowkey Vault)
pnpm docker:dev:copilot           # Full stack with Copilot worker + portal (hot reload)
pnpm docker:dev:all               # All workers + portal + report generator (hot reload)
pnpm dev:api                      # API only (native)
pnpm dev:portal                   # Portal only (native)
pnpm dev:<worker-name>            # Individual worker (native)
pnpm open:portal                  # Open portal in browser
```

### Shared Dev Infrastructure (CosmosDB)

For testing against real Azure CosmosDB (e.g. index behavior), a shared dev instance can be provisioned. Each worktree gets its own isolated database. See [docs/shared-dev-infra.md](docs/shared-dev-infra.md) for setup and usage.

## Rust Components

When making changes to any Rust component (e.g. the AI gateway in `apps/gateway/`), follow the `rust-best-practices` skill. This skill is available at `.agents/skills/rust-best-practices/SKILL.md` and covers idiomatic Rust, ownership patterns, error handling with `Result`, and performance guidelines.

## Testing

Co-locate tests next to source as `<filename>.test.ts`. Framework: Vitest.

```bash
pnpm test                         # Unit tests
pnpm test:coverage                # With coverage report
pnpm test:integration             # Integration tests (requires .env + Docker)
```

> **Portal Storybook stories run under Vitest**: `apps/portal/src/components/ui/stories.play.test.tsx` composes the `ui/*` stories and executes their `play` (interaction) functions inside the regular Vitest suite (no `@storybook/addon-vitest` required). It binds a Testing Library `canvas` to the rendered container, so story `play` functions must keep depending only on `canvas` plus values imported directly from `storybook/test` (`userEvent`, `screen`, `expect`). When you add a new `ui/*` story with a `play` function, register its module in that harness so it's covered.

## Contributing (Pull Requests)

This repository is commonly worked on from a **fork**. When opening a pull
request, **always target the upstream repository when one is available** — do
not open the PR against the fork unless the user explicitly asks you to.

- Detect the upstream: check `git remote -v`. If an `upstream` remote exists
  (e.g. `microsoft/scope`), that is the PR base. The `origin` remote is
  typically your personal fork (e.g. `cedricvidal/scope`).
- Push the branch to your fork (`origin`), then open the PR **across forks**
  with the upstream as the base:
  ```bash
  gh pr create \
    --repo <upstream-owner>/<repo> \
    --base main \
    --head <fork-owner>:<branch> \
    --title "..." --body-file <path>
  ```
- Only fall back to opening the PR against the fork (`origin`) when there is no
  `upstream` remote, or when the user explicitly requests it.
- If the upstream org enforces **SAML SSO** and the PR call fails with a `403`
  ("Resource protected by organization SAML enforcement"), stop and ask the
  user to authorize their token for that org via the SSO link, then retry —
  do not silently downgrade to a fork PR.

## Documentation Workflow

**Before starting any task**, read the docs relevant to the components you will be working on (see the table below). Understanding the existing design, data models, and patterns prevents regressions and duplicated work.

**Before completing any task**, update the relevant docs to reflect your changes. This is the last step before calling the work done. If you added a new component, added or changed an API, modified data models, introduced a new pattern, or changed deployment behavior, the corresponding doc must be updated (or a new one created and linked here). Documentation is not optional — outdated docs are worse than no docs.

## Documentation

| Document | Description |
|----------|-------------|
| [docs/architecture/overview.md](docs/architecture/overview.md) | System architecture, component interactions, data flow |
| [docs/architecture/app-design.md](docs/architecture/app-design.md) | Data models, API design, package dependency graph |
| [docs/architecture/data-organization-projects.md](docs/architecture/data-organization-projects.md) | Projects (a single container) to isolate/group data within a cluster; composes with data-tags and auth-rbac |
| [docs/architecture/auth-rbac.md](docs/architecture/auth-rbac.md) | Explicit-login IdP auth, Redis user-access cache, Portal handshake; deferred RBAC/internal-token roadmap |
| [docs/architecture/vscode-web-worker.md](docs/architecture/vscode-web-worker.md) | XState chat machine, GitHub auth flow, ARIA snapshots |
| [docs/architecture/token-manager.md](docs/architecture/token-manager.md) | Token storage, validation, round-robin distribution |
| [docs/architecture/criteria-provider.md](docs/architecture/criteria-provider.md) | CriteriaProvider abstraction, filesystem vs REST backends |
| [docs/architecture/skills.md](docs/architecture/skills.md) | Agent Skills spec, registration, resolution, delivery |
| [docs/architecture/codebases.md](docs/architecture/codebases.md) | Codebase entity, immutable revisions, source types, worker seeding |
| [docs/architecture/db-migrations.md](docs/architecture/db-migrations.md) | MongoDB migration framework |
| [docs/architecture/cli-distribution.md](docs/architecture/cli-distribution.md) | CLI bundling, publishing, installation, update check |
| [docs/architecture/retry.md](docs/architecture/retry.md) | Retry utilities: `withRetry` function and `@Retry` decorator |
| [docs/architecture/post-processing.md](docs/architecture/post-processing.md) | Post-processing pipeline, ATIF generation, handler extensibility |
| [docs/architecture/observability.md](docs/architecture/observability.md) | Application telemetry, Azure Monitor OTel distro, custom worker metrics |
| [docs/architecture/kubedock.md](docs/architecture/kubedock.md) | Kubedock sidecar, container access for agents, Kustomize Component toggle |
| [docs/research/realtime-data-flow.md](docs/research/realtime-data-flow.md) | SSE + Change Streams, Redis pub/sub, polling patterns |
| [docs/research/delta-storage.md](docs/research/delta-storage.md) | Space-efficient storage of iteration snapshots |
| [docs/shared-dev-infra.md](docs/shared-dev-infra.md) | Shared dev infrastructure (CosmosDB) setup and worktree isolation |
| [ENV_VARIABLES.md](ENV_VARIABLES.md) | Environment variable reference |
