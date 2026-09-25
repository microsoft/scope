# Contributing to Scope

Thanks for your interest in contributing! This guide covers the legal
requirements, how to set up a local environment, the conventions we follow, and
how to get a change reviewed and merged.

## Contributor License Agreement (CLA)

This project welcomes contributions and suggestions. Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit https://cla.opensource.microsoft.com.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide
a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions
provided by the bot. You will only need to do this once across all repos using our CLA.

## Code of Conduct

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.
See [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) for the full statement.

## Reporting security issues

Please **do not** report security vulnerabilities through public GitHub issues. Follow the process in
[`SECURITY.md`](./SECURITY.md) to report them to the Microsoft Security Response Center (MSRC).

## Prerequisites

Scope is a pnpm workspaces monorepo (TypeScript, with a Rust component for the AI gateway).

- **Node.js 22** — the version CI builds and tests against.
- **pnpm 10.29.1** — pinned via the `packageManager` field in [`package.json`](./package.json).
  The easiest way to get the right version is Corepack:

  ```bash
  corepack enable
  ```

- **Docker** — required to run the backing services (MongoDB, Redis, Azurite, Lowkey Vault) and to
  run integration tests.
- **[mkcert](https://github.com/FiloSottile/mkcert#installation)**: required for
  trusted HTTPS certificates when running the local authentication emulator.
- **[GitHub CLI](https://cli.github.com/)**: used to obtain a token for local
  Copilot runs. The account supplying the token must have an **active GitHub
  Copilot entitlement**; `gh auth login` alone does not grant Copilot access.
- **Rust / Cargo** — only needed if you work on the AI gateway (`apps/gateway/`).

## Getting started

```bash
pnpm install                      # Install all workspace dependencies
```

CI installs with `pnpm install --frozen-lockfile`; commit an updated `pnpm-lock.yaml` when you change
dependencies.

## Local development

Local authentication requires your browser to trust a development certificate.
The Portal development scripts run `mkcert -install` to add a local certificate
authority to the OS/browser trust store and generate the emulator's `localhost`
certificate. On first use, you may be prompted to approve this trust-store
change. Follow the
[local authentication instructions](./ENV_VARIABLES.md#local-dev-setup-entra-local)
for details.

For the Copilot worker, authenticate with an account that has an active Copilot
entitlement and make its token available to the development stack:

```bash
gh auth login
export GITHUB_TOKEN="$(gh auth token)"
```

Start the backing services first, then run the stack or an individual service:

```bash
pnpm docker:up:infra              # Start backing services (MongoDB, Redis, Azurite)
pnpm docker:dev:copilot           # Full stack with the Copilot worker + portal (hot reload)
pnpm docker:dev:all               # All workers + portal + report generator (hot reload)

pnpm dev:api                      # API only (native)
pnpm dev:portal                   # Portal only (native)
pnpm dev:coder-acp-copilot        # A single worker natively (pnpm dev:<service-name>)
pnpm open:portal                  # Open the portal in your browser
```

### Debug the Docker development API

`pnpm docker:dev:portal` starts the API with the Node inspector enabled. To
debug API TypeScript while retaining the Docker stack and hot reload:

1. Run `pnpm docker:dev:portal` and wait for the API to start.
2. Read `API_DEBUG_PORT` from the generated `.env` file (it is worktree-specific).
3. In VS Code, select **Attach API (Docker)** from **Run and Debug**, enter that
   port, and start debugging.
4. Set breakpoints in the workspace source under `apps/api/src`, not in a copied
   or attached snapshot of the file.

The debugger maps the container's `/app` tree to the workspace and reconnects
when `tsx watch` restarts the API after a source change. The inspector is
published on `127.0.0.1` only.

The CLI is the primary interface for CI/CD and power users:

```bash
pnpm cli --help                   # Discover CLI subcommands
```

## Testing

Tests are co-located next to source as `<filename>.test.ts` and run with [Vitest](https://vitest.dev/).

```bash
pnpm test                         # Unit tests
pnpm test:coverage                # Unit tests with a coverage report
pnpm test:integration             # Integration tests (requires a .env file + Docker)
```

## Build, lint, and typecheck

```bash
pnpm build                        # Build every workspace package (pnpm -r build)
pnpm lint                         # Lint/typecheck every package (pnpm -r lint)
```

For the Rust gateway (`apps/gateway/`):

```bash
pnpm build:gateway                # cargo build --release
pnpm test:gateway                 # cargo test
pnpm lint:gateway                 # cargo clippy -- -D warnings
pnpm fmt:gateway                  # cargo fmt --check
```

## Database migrations

Schema changes live in [`packages/db-migrations/`](./packages/db-migrations/) and use
`mongo-migrate-ts` (TypeScript files with `up()` / `down()`):

```bash
pnpm migrate:up                   # Apply pending migrations
pnpm migrate:down                 # Roll back the last migration
pnpm migrate:status               # Show migration status
```

MongoDB is CosmosDB-compatible — avoid MongoDB features that CosmosDB's MongoDB API does not support.

## Coding conventions

- **TypeScript**: strict mode, ES2022, NodeNext modules.
- **License headers**: every first-party source file must start with the Microsoft MIT header. Run
  `pnpm headers` to add it; CI enforces it via `pnpm headers:check`.
- **Tests**: co-locate them next to the source as `<filename>.test.ts` (Vitest).
- **CLI ↔ Portal parity**: every feature available in the Portal must also be available in the CLI —
  the CLI must never lag behind the Portal.
- **Portal + Storybook**: when you add or change a portal component, update its Storybook stories.
- **Rust**: for any change under `apps/gateway/`, follow the `rust-best-practices` skill
  (`.agents/skills/rust-best-practices/SKILL.md`).
- **Databases**: keep MongoDB usage CosmosDB-compatible (see migrations above).
- **Documentation is not optional**: if you add or change a component, API, data model, pattern, or
  deployment behavior, update the relevant doc in [`docs/`](./docs/) (or add one and link it from the
  README) as the last step before opening your PR.

## Submitting a pull request

1. Fork the repository and create a topic branch from `main`.
2. Make your change, keeping it focused and adding/adjusting co-located tests.
3. Run `pnpm lint` and `pnpm test` locally (plus `pnpm test:integration` when your change touches a
   worker or backing service) and make sure they pass.
4. Update any documentation affected by your change.
5. Write clear, descriptive commit messages and PR descriptions; link the issue(s) your PR addresses.
6. Open the PR and complete the CLA check if the bot asks you to. Address review feedback and keep the
   branch up to date with `main`.

See [Reviewing and merging community contributions](#reviewing-and-merging-community-contributions)
for what to expect, including our acknowledgement target and follow-up on PRs waiting for a response.

### Recording a demo

For user-visible changes (Portal/CLI features or UX changes), attach a short recording in the PR's
Demo section. For user-visible bug fixes, show the same steps before and after the fix. Aim for
20-30 seconds focused on the changed interaction and its result. Write "N/A" for changes that aren't
user-visible, such as documentation, internal refactors, or infrastructure-only changes.

Use a screen recorder such as macOS Screenshot (`Shift+Command+5`), Windows Snipping Tool's video
capture, or OBS Studio to capture the relevant browser or terminal area. An agent with browser or
terminal automation and recording tools can run the steps and produce an annotated recording for
you; review its output before uploading.

Use synthetic data and scrub tokens, cookies, credentials, and real run/customer data from the
recording, including terminal output and browser UI. Check the entire clip before sharing it.
Drag and drop an `.mp4`, `.mov`, or `.gif` into the PR description to upload it to GitHub, and add a
one-line caption describing what it shows so reviewers can search for the behavior.

Recordings complement, not replace, the Testing section: keep test commands, results, and any manual
checks in text. Screenshots can add context but do not show interaction or timing.

## Reviewing and merging community contributions

This process guides how the Scope team reviews and merges external contributions.

### 1. Assign an owner and confirm scope

Aim to acknowledge each external PR within **three business days**. Assign a team member to
coordinate the review and follow it through to merge or closure. Confirm that the change fits
Scope's direction before asking the contributor for substantial revisions. Discuss larger
features or architectural changes in an issue first.

Reviewer routing is the team's responsibility, not the contributor's. Until automated routing is
configured, the team designates a triage maintainer to check incoming PRs each business day, assign
a maintainer as the PR owner, and request reviewers familiar with the affected area.

**Team follow-up:** add a `CODEOWNERS` file with a catch-all maintainers team and area owners for
high-risk paths, including `.github/workflows/`, `packages/db-migrations/`, `packages/github-auth/`,
`apps/token-manager/`, auth/RBAC and project-scoping code, and `packages/shared/`. Configure team
review assignment to distribute requests, and branch protection to require code-owner review and
dismiss stale approvals. These mechanisms are not configured by this policy change; until they
are, the PR owner coordinates reviews and the merging maintainer checks the approval requirements.

### 2. Check readiness

Before a detailed review, confirm that the PR explains what changed and why, satisfies the CLA
requirement, and includes relevant tests and documentation. Portal/CLI user-visible changes should
include the demo requested by the PR template. If anything is missing, give the contributor a clear
next step.

### 3. Review proportionately

Require **one team maintainer's approval** for routine changes. Require **two team maintainers'
approvals**, including someone familiar with the affected area, for changes involving
authentication, permissions, project scoping or data isolation, data migrations, CI/deployment,
new or upgraded dependencies, breaking APIs, or breaking changes to `packages/shared/`.

Review correctness, maintainability, security, and compatibility. Apply Scope's existing
requirements, including CLI/Portal parity, Storybook updates, and CosmosDB-compatible migrations
where relevant. AI review can help, but does not replace human approval.

### 4. Give clear, respectful feedback

Keep decisions in the PR so contributors can follow them. Distinguish **required changes** from
**optional suggestions**, explain the reason for blockers, and avoid expanding the PR into
unrelated work. If reviewers disagree, the PR owner brings in the relevant maintainer to resolve
it.

Treat external code as untrusted when running it. Do not expose credentials, production data, or
privileged runners to unreviewed code. Before clicking **Approve and run workflows** for a fork
PR, read the diff. Give extra scrutiny to `.github/workflows/`, including gh-aw `.md` and
`.lock.yml` agentic workflows, and to `package.json` scripts and lifecycle hooks. Never add
`pull_request_target` or secrets-bearing triggers to handle fork PRs. Route vulnerability reports
through [`SECURITY.md`](./SECURITY.md).

### 5. Merge only when ready

A team maintainer merges once:

- The required approvals cover the latest substantive changes.
- Required checks pass and blocking feedback is resolved.
- Relevant testing is complete. A check skipped on a fork is not evidence that it passed.
- The CLA requirement is satisfied and any compatibility or rollout implications are documented.

Use **squash merge** for a focused history. Keep the contributor as the commit author and preserve
`Co-authored-by:` trailers for other contributors who authored commits in the PR. Use a
Conventional Commit title with the PR number, for example
`docs: clarify contribution review policy (#1413)`. Do not bypass checks or approvals just to
unblock a PR.

### 6. Close the loop

Thank the contributor and link any follow-up work. The PR owner checks the post-merge result and
coordinates a fix or revert if needed.

If a contribution is not a fit, explain why and close it promptly. When a PR is waiting on the
contributor after a clear request for information or changes, send a reminder after **two weeks
without a response**. Close it **two weeks after the reminder (four weeks total)** if there is
still no response, making clear that the contributor can resume later. Do not close PRs under
this rule when they are waiting on the team.

The PR owner applies `status: waiting` when requesting a contributor response and removes it when
the contributor responds. State who owes the next action in a comment; the label alone must not
trigger the closure policy, particularly when a PR is waiting on the team.

## Repository labels

Use the existing `category: value` labels for issue and PR triage. Check the
[live label list](https://github.com/microsoft/scope/labels) before applying labels;
do not recreate retired names or the migration-only `author:` labels.
Keep `good first issue` and `help wanted` unprefixed for contribution discovery.

Automations depend on these exact names:

| Consumer | Labels |
| --- | --- |
| Worker version checker and upgrade workflow | `type: worker-update` |
| Test Improver issues, PRs, and monthly-summary searches | `type: automation`, `topic: testing` |
| Daily repository status reports | `agentic-workflows` |
| Dependabot | `type: dependencies`, plus `language: javascript` or `language: rust` |

Use `area: reporting` for Scope's benchmark reporting component, not daily repository activity.
Worker upgrade routing uses `type: worker-update`, not the broader `area: worker`.

### Agentic Workflows system-label exception

The pinned GitHub Agentic Workflows runtimes hard-code the unprefixed `agentic-workflows`
label when searching for and creating failure reports, no-op tracking issues, and PR fallback
issues. This is a machine-managed compatibility exception to the namespaced label convention.

Before relying on these workflows after a label migration, a maintainer must ensure
`agentic-workflows` exists and is applied to existing workflow tracking issues that were renamed,
especially `[aw] No-Op Runs` and `[aw] ... failed` issues. Otherwise the runtime can miss existing
trackers and attempt duplicate reports. Keep this exact name until every active runtime supports
a replacement for both lookups and writes.
Changing `safe-outputs` label lists alone does not change these built-in handlers.
Repository configuration does not create or backfill this label automatically.

### Updating label-dependent configuration

Update both the label filters and label writes in `.github/workflows/check-worker-versions.yml`,
the agentic workflow `.md` frontmatter, and any label searches in their prompts.
Regenerate the corresponding `.lock.yml` files with `gh aw compile`; do not edit generated YAML
by hand. Use each file's recorded compiler version to avoid unrelated runtime upgrades:

| Workflow | Compiler |
| --- | --- |
| `daily-test-improver` | `v0.57.1` |
| `daily-repo-status` | `v0.60.0` |
| `worker-version-upgrade` | `v0.63.0` |

The daily schedules are explicit cron expressions preserving their existing UTC execution times.
Review changes to `.github/aw/actions-lock.json` and generated workflow permissions, triggers,
action pins, and handler configuration before merging.

`.github/dependabot.yml` specifies namespaced labels for the root pnpm workspace, the separate
website package, and the Rust gateway. Each entry has `open-pull-requests-limit: 0` to keep
version-update PRs disabled; the required schedule does not enable those PRs. These labels also
apply to security-update PRs when security updates are enabled in repository settings. This file
does not enable security updates or change live labels.

## Third-party notices

Scope redistributes npm production dependencies in its service images and Rust
crates in the gateway binary. Their attributions and license texts are collected
in the root [`NOTICE`](./NOTICE) file.

`NOTICE` is generated; don't edit it by hand. Regenerate it after changing
dependencies:

```bash
pnpm notice          # Regenerate NOTICE and NOTICE-REVIEW.txt
pnpm notice:check    # Check whether the committed notices are current
```

The generator ([`scripts/generate-notice.ts`](./scripts/generate-notice.ts))
orchestrates license tooling and concatenates its verbatim output. It doesn't
author or edit license text. It uses
[`generate-license-file`](https://generate-license-file.js.org) for npm production
dependencies and [`cargo-about`](https://github.com/EmbarkStudios/cargo-about) for
crates compiled into the gateway. npm exclusions and multi-license disambiguation
live in the generator; Rust configuration and templates live in
[`apps/gateway/about.toml`](./apps/gateway/about.toml) and
[`apps/gateway/about.hbs`](./apps/gateway/about.hbs).
Only [`scripts/notice-header.txt`](./scripts/notice-header.txt) is written by hand.
Production packages whose licenses can't be resolved as standard open source
are excluded from `NOTICE` and listed in `NOTICE-REVIEW.txt` for manual legal
review.

`generate-license-file` runs through `npx`. To regenerate the Rust portion,
install its tool with `cargo install cargo-about --features cli`. Set
`SKIP_CARGO=1` to reuse the cached Rust section when it hasn't changed.

Both notice files are platform-independent. Per-platform native binaries
(`@os-theme/*` and `@github/copilot-<os>-<arch>`) and macOS-only `fsevents` are
excluded so macOS and Linux produce the same output. Attributions for excluded
native binaries are carried by their platform-independent parent packages.
The `notice-check` job in [CI](./.github/workflows/ci.yml) checks for drift from
installed dependencies.

## Project structure and where to start

- Start with the [system architecture](./docs/architecture/system-architecture.md) and the
  [app design](./docs/architecture/app-design.md) docs for the big picture.
- The [README](./README.md) introduces the platform, provides a local quick start, and links the full documentation index.
- Browse [open issues](https://github.com/microsoft/scope/issues) for bugs and
  proposed improvements. Discuss larger changes in an issue before starting work.
