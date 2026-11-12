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
pnpm start                        # Interactive guide to the commands below (alias: pnpm scope)
```

CI installs with `pnpm install --frozen-lockfile`; commit an updated `pnpm-lock.yaml` when you change
dependencies.

The workspace intentionally skips the optional `ssh2` and `cpu-features` native
install scripts. Scope uses `ssh2` only transitively through Docker test tooling,
and its supported JavaScript implementation preserves that behavior without a
Python/compiler toolchain. Keep required dependency build scripts allowlisted in
`pnpm-workspace.yaml`; do not replace this narrow policy with `--ignore-scripts`.

### Interactive contributor guide

Not sure which command to run? `pnpm start` (or its alias `pnpm scope`) asks a few
questions, such as what you want to do and which worker you need, then:

1. checks the prerequisites for that task (such as the Docker daemon, mkcert,
   `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, Rust, built workspace packages or the
   generated `.env`), and explains how to fix anything missing;
2. shows the exact `pnpm` command or commands, with a warning when they delete
   data, spend provider credits or are experimental;
3. runs them only after you confirm. Destructive commands default to **No**.

```bash
pnpm start                        # Guided menu; after a run, it offers to repeat your last choice
pnpm start --list                 # Print every command, grouped by topic
pnpm start --dry-run              # Answer the questions and see the commands without running them
```

If `GITHUB_TOKEN` is missing but the GitHub CLI is signed in, the guide offers to
pass `gh auth token` to that one command; the token is never printed or saved.
The last choice is stored per worktree in `.dev-state/guide/last.json`. On a fresh
clone, `pnpm start` offers to run `pnpm install --frozen-lockfile` first. In
non-interactive shells (CI, pipes), it prints the `--list` output instead of
prompting. The guide only runs existing root scripts; you can always run them
directly.

When you add, rename or remove a contributor-facing root script, update its
recipe in [`scripts/guide/catalog.ts`](./scripts/guide/catalog.ts) (and the menu
in [`scripts/guide/tree.ts`](./scripts/guide/tree.ts) if it belongs in the guided
flow). Scripts without a recipe still appear under "Other scripts".

## Local development

### Choose how to run Scope

| Option | Commands | Where it runs | Hot reload | Status |
| --- | --- | --- | --- | --- |
| **Docker Compose** | `pnpm docker:dev:copilot` or `pnpm docker:dev:all` | Docker on your machine | Yes (Compose watch, polling) | Recommended; see [Compose workflow](#compose-workflow) |
| **Native processes** | `pnpm docker:up:infra`, then `pnpm dev:api`, `pnpm dev:portal`, `pnpm dev:<worker>` | Apps on your machine, databases in Docker | Yes | Supported; see [Compose workflow](#compose-workflow) |
| **Devcontainer, native mode** | `pnpm dev:up --mode=native` | Inside the devcontainer | Yes | Experimental; not yet tested end to end |
| **Devcontainer, Kind mode** | `pnpm dev:up --mode=kind --services=api,portal` | Kind cluster inside the devcontainer | No (rebuild with `--build`) | Experimental; tested in Codespaces, including browser sign-in |

Which to pick:

- **Day-to-day work and running real benchmarks:** Docker Compose. It is the only
  option that runs workers, which spend provider credits.
- **Working on a single service:** native processes, for the fastest reloads and
  simplest debugging.
- **Kubernetes or ServiceAccount work:** the devcontainer in Kind mode, preferably
  in GitHub Codespaces until it has been tried on local Docker.

### Devcontainer (experimental)

The devcontainer bundles the toolchain and its own Docker daemon (Docker-in-Docker),
so it needs only Docker and VS Code, but it must run as a **privileged container**.
It is not a security sandbox: use a disposable environment without sensitive
mounts or credentials.

- Native mode runs the databases in the devcontainer's Docker and the API and
  Portal as processes behind one HTTPS address.
- Kind mode runs the whole stack in a Kubernetes cluster with one ServiceAccount
  per workload. The first start builds a large tools image (about 6.5 GB); later
  starts take about five minutes. Workers are rendered but never started, and
  only the API and Portal have been verified.
- In Codespaces, forward port 8080 as a **private** port, open the printed
  `https://<codespace>-8080.app.github.dev` URL, and sign in with
  `alice@entralocal.dev` / `Password1!`.
- Docker Desktop, WSL2, macOS and local-browser sign-in have not been validated.
  On WSL2, keep the repository on the Linux filesystem, not under `/mnt/c`.

See [devcontainer.md](./docs/architecture/devcontainer.md) for the commands,
debugging, identities, evidence and remaining work. Never transfer a development
CA private key to the browser host.

### Compose workflow

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

The first Docker start compiles the Rust AI gateway inside its development
container and can take several minutes. During development, the gateway may use
all CPUs assigned to Docker or the Podman VM, while its memory remains limited
to 2 GiB. Keep the Compose command running until the `coder-acp-copilot` logs
show that it connected to MongoDB and ensured `queue-coder-acp-copilot`; runs
submitted before that worker is ready remain pending. Later starts reuse the
gateway's named Cargo target volume and are faster.

### Prepare container storage for a clean rebuild

Before a large clean Docker or Podman rebuild, inspect the container runtime's
storage rather than relying only on host free space. Docker Desktop and Podman
Machine commonly keep images, writable layers, build cache, and named volumes
inside a VM or separate filesystem. That storage can fill independently while
the host still appears to have ample capacity.

A first clean Copilot-stack build needs substantial temporary and persistent
runtime space because it pulls base images, installs dependencies, and compiles
the Rust gateway before caches can be reused. Treat this as planning guidance,
not a fixed minimum: usage varies with the platform, CPU architecture, enabled
profiles, existing layers, and cache state. Confirm the runtime has comfortable
headroom before starting instead of relying on a universal threshold.

These commands identify the selected Docker daemon and inspect its object usage:

```bash
docker context show
docker context inspect "$(docker context show)" \
  --format 'Endpoint={{.Endpoints.docker.Host}}'
docker info \
  --format 'Name={{.Name}} OperatingSystem={{.OperatingSystem}} DockerRootDir={{.DockerRootDir}}'
docker system df
docker system df -v
```

`docker system df` reports Docker object usage, not the filesystem's total
capacity or free space. Check the filesystem containing `DockerRootDir` on the
actual daemon host:

- For a native local Linux daemon, run
  `docker_root="$(docker info --format '{{.DockerRootDir}}')" && df -h "$docker_root"`.
- For an SSH, TCP, or other remote context, use the approved access path to
  that daemon host and run `df -h` there. Running `df` on the CLI host does not
  measure the remote daemon's storage.
- For Docker Desktop, inspect **Settings > Resources > Advanced > Disk usage
  limit** and **Disk image location**, then confirm the filesystem containing
  that image has headroom. See Docker's
  [Resources settings](https://docs.docker.com/desktop/settings-and-maintenance/settings/#resources).

When Docker commands target a Podman socket, also inspect Podman directly.
On macOS or Windows, check both the configured machine size and free space
inside the running VM. Do not select the first listed machine: compare the
active Docker context endpoint and Podman connection URI with the running
machines, then set the verified machine name explicitly:

```bash
docker context inspect "$(docker context show)" \
  --format 'Endpoint={{.Endpoints.docker.Host}}'
podman system connection list
podman machine list
podman system df
podman system df -v
machine_name="<verified-running-machine>"
test -n "$machine_name"
podman machine ssh "$machine_name" \
  df -h / /var /var/lib/containers
```

After `scripts/worktree-env.sh` or a `pnpm docker:*` command has generated
`.env`, use the Compose project label to distinguish this worktree's resources
from unrelated projects:

```bash
scope_project="$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' .env | tail -n 1)"
test -n "$scope_project"
docker ps -a --filter "label=com.docker.compose.project=$scope_project"
docker compose images
docker volume ls --filter "label=com.docker.compose.project=$scope_project"
```

`docker system df -v` also shows Docker build-cache usage, but cache records are
not always attributable to one Compose project. `podman system df -v` reports
images, containers, and volumes, including shared image-layer usage; it does not
provide a separate Docker BuildKit-style build-cache section. Do not assume
that all reclaimable or shared storage belongs to Scope.

If storage is low, use this decision sequence:

1. Inspect runtime and, when applicable, VM filesystem usage.
2. Identify stopped containers, images, runtime-reported build-cache records,
   and volumes that belong to this exact Scope worktree.
3. Prefer removing only verified Scope resources. Ask the user before cleanup,
   and do not recommend broad `system prune`, `volume prune`, wildcard removal,
   or deletion of unrelated runtime resources.
4. Re-run the inspection commands and retry the build only after confirming
   adequate free space.

The following are **destructive examples** for resources whose exact IDs or
names have already been verified and whose removal the user approved:

```bash
docker container rm "$SCOPE_STOPPED_CONTAINER_ID"
docker image rm --no-prune "$SCOPE_IMAGE_ID"
docker volume rm "$SCOPE_VOLUME_NAME"

# Native Podman equivalents
podman rm "$SCOPE_STOPPED_CONTAINER_ID"
podman rmi --no-prune "$SCOPE_IMAGE_ID"
podman volume rm "$SCOPE_VOLUME_NAME"
```

Do not run these with unset variables, `--all`, `--force`, or glob-expanded
names. Named volumes can contain local MongoDB, Azurite, authentication, gateway
build, or worker workspace data; inspect and confirm their contents and impact
before deleting them. If a Scope-specific build-cache record cannot be
identified confidently, leave it in place rather than pruning shared cache.

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

[CI's](./.github/workflows/ci.yml) worker integration, queue recovery and Windows build jobs
require `github.repository == 'microsoft/scope'`: they do not execute in fork
repositories. A fork PR into upstream still runs the ACP workers' tool checks and
the disposable MongoDB/Redis/Azurite queue tests. Worker credentials are withheld
from fork-head code, so the existing live-auth tests skip when credentials are
absent. Docker Hub login is optional and restricted to trusted code; public images
can be pulled anonymously. LLM evals require trusted PR heads.
The OSS CI workflow does not publish container images or request OIDC;
its ACP test images are built and loaded locally. Public CI requires no Azure/ACR
setup. PR test reporting and video
uploads remain enabled, with missing video directories treated as no recordings.

Changes to the CI workflow select the integration checks through a dedicated
path filter. Run the focused workflow
regressions with `pnpm exec vitest run scripts/ci-workflow.test.ts` and the real
queue tests with `pnpm test:integration:queue` (Docker required).
The ACP matrix covers the existing Copilot and Claude workers; the removed VS Code
workers have no Dockerfiles or integration suites in this repository.
Live-model credentials remain necessary for live-auth tests; passing public
tool checks does not validate live-model access.

All external GitHub Actions and reusable workflows must use an immutable,
full-length commit SHA followed by the corresponding release version:

```yaml
- uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
```

When updating an action, update the SHA and version comment together. The
dedicated **Pin GitHub Actions** check validates both through
[pinact](https://github.com/suzuki-shunsuke/pinact), while
`scripts/ci-workflow.test.ts` independently rejects mutable references and
missing comments. If pinact is installed locally, run the same validation with:

```bash
pinact run --check --verify-comment
```

Windows validation uses GitHub's `windows-2022` runner and its Windows Docker
engine. `scripts/build-windows-worker.ps1` builds `Dockerfile.base` from public
`servercore:ltsc2022`, builds pinned Copilot dependencies against that local image,
then builds and smoke-tests the worker against the local dependencies image.
No internal registry, prebuilt private image, secrets or image publication is
required. Changes to the Windows worker, Linux Copilot dependency, shared packages,
telemetry, workspace/build context, or CI select this check; failures block
CI Summary. Run the same script locally on Windows Server 2022 with Docker.
The PowerShell orchestration tests require `pwsh` (included on GitHub's Ubuntu
runners); they mock Docker and do not replace the hosted Windows image build.

The OSS repository does not depend on internal `scope-core` automation. The
internal infrastructure status report and cloud image publishers are removed;
Windows build validation is local, while CLI release publication is retained in
this repository using its own `GITHUB_TOKEN`. Public Pages is unchanged. The
manual CLI release workflow runs only on upstream `main`, builds and tests the
exact bundle before publishing it to `microsoft/scope`, and needs no FLUX token.
See [CLI distribution](./docs/architecture/cli-distribution.md) for versioning,
installation and update behavior.

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

Reviewer routing is the team's responsibility, not the contributor's. The repository's
[`CODEOWNERS`](./.github/CODEOWNERS) file now routes review requests by area. The team should still
designate a triage maintainer to check incoming PRs each business day, assign a maintainer as the PR
owner, and request additional reviewers familiar with the affected area when needed.

Keep the [`CODEOWNERS`](./.github/CODEOWNERS) file current as maintainers and area ownership evolve.
Team review assignment and branch protection still need to be configured to distribute requests,
require code-owner review, and dismiss stale approvals. Until those settings are enabled, the PR
owner coordinates reviews and the merging maintainer checks the approval requirements.

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

Thank the contributor and link any follow-up work. Once merged, the author appears in the
"Thank you" section of the [Contribute page](https://microsoft.github.io/scope/community/contribute/#thank-you)
and on the landing page after the merge-triggered contribution-data workflow completes. The PR
owner checks the post-merge result and coordinates a fix or revert if needed.

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
| Dependabot | `type: dependencies`, plus `language: javascript` or `language: rust` |
| Pull Request Labeler | Area, topic, language, and type labels from `.github/labeler.yml` |
| Community Contribution Labeler | `community-contribution` |

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
`.github/labeler.yml`, the agentic workflow `.md` frontmatter, and any label searches in their prompts.
Regenerate the corresponding `.lock.yml` files with `gh aw compile`; do not edit generated YAML
by hand. Use each file's recorded compiler version to avoid unrelated runtime upgrades:

| Workflow | Compiler |
| --- | --- |
| `daily-test-improver` | `v0.57.1` |
| `worker-version-upgrade` | `v0.63.0` |

The daily schedules are explicit cron expressions preserving their existing UTC execution times.
Review changes to `.github/aw/actions-lock.json` and generated workflow permissions, triggers,
action pins, and handler configuration before merging.

`.github/dependabot.yml` specifies namespaced labels for the root pnpm workspace, the separate
website package, and the Rust gateway. Each entry has `open-pull-requests-limit: 0` to keep
version-update PRs disabled; the required schedule does not enable those PRs. These labels also
apply to security-update PRs when security updates are enabled in repository settings. This file
does not enable security updates or change live labels.

`.github/workflows/labeler.yml` runs on the unprivileged `pull_request` event and skips fork PRs.
Do not switch it to `pull_request_target` just to label fork PRs; that would violate the fork-PR
security boundary above. `.github/workflows/community-contribution-labeler.yml` labels issues
directly and follows completed PR labeler runs, using GitHub metadata only to apply
`community-contribution` to human authors whose association is `NONE`, `FIRST_TIMER`,
`FIRST_TIME_CONTRIBUTOR`, or `CONTRIBUTOR`. It requires `issues: write` for issue labels and
`pull-requests: write` for pull request labels, but it must not check out pull request code,
download artifacts, or receive repository secrets.

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
