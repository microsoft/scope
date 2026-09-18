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
  deployment behavior, update the relevant technical doc in [`docs/`](./docs/) and user-facing
  guide in [`website/src/content/docs/`](./website/src/content/docs/) as appropriate. Add new
  website pages to the sidebar in [`website/astro.config.mjs`](./website/astro.config.mjs)
  as the last step before opening your PR.

## Submitting a pull request

1. Fork the repository and create a topic branch from `main`.
2. Make your change, keeping it focused and adding/adjusting co-located tests.
3. Run `pnpm lint` and `pnpm test` locally (plus `pnpm test:integration` when your change touches a
   worker or backing service) and make sure they pass.
4. Update any documentation affected by your change.
5. Write clear, descriptive commit messages and PR descriptions; link the issue(s) your PR addresses.
6. Open the PR and complete the CLA check if the bot asks you to. Address review feedback and keep the
   branch up to date with `main`.

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
- The [official documentation website](https://microsoft.github.io/scope/) includes
  [local setup](https://microsoft.github.io/scope/getting-started/local-development/),
  the [development guide](https://microsoft.github.io/scope/resources/development/), and
  [contribution guidance](https://microsoft.github.io/scope/resources/contributing/).
- Browse [open issues](https://github.com/microsoft/scope/issues) for bugs and
  proposed improvements. Discuss larger changes in an issue before starting work.
