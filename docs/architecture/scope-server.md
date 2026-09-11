# Scope Server

Scope Server adds a private local npx deployment alongside the existing Compose
and Kubernetes deployments. This document does not announce a published npm
release. The observed runtime coverage and remaining environment blockers are
listed below.

## Private installation and packaging

Maintainers build the artifact from the monorepo:

```sh
pnpm install --frozen-lockfile
pnpm pack:server
```

This writes `apps/server/.artifacts/scope-server-0.1.0.tgz`. Consumers need
Node.js 22.13+, npm/npx, and a running local Docker-compatible engine with a Unix
socket. The launcher uses the engine selected by `DOCKER_HOST` or the Docker CLI
context; remote TCP and native Windows named-pipe engines are not supported.

```sh
npx --package ./scope-server-0.1.0.tgz scope-server
```

The private `@scope/server` package contains the compiled launcher/host workers,
version-matched Scope sources, Dockerfiles, lockfile and configuration assets.
It never checks out Scope or pulls prebuilt Scope images from a registry.
Published npm dependencies (including the Claude ACP adapter) and public base
images can download. Node and Docker are not bundled.

The package builds `.scope` copies of the existing Dockerfiles, leaving the
Compose/Kubernetes recipes unchanged. These copies install the same pinned pnpm
version through npm, supporting registry proxies that lack Corepack's
version-specific metadata route. Builds honor the configured npm registry and
HTTP(S) proxy. Packaged metadata keeps the npm version separate from a UTC
ISO-8601 build timestamp; that timestamp and a metadata-derived local commit
stamp are reused in image build arguments, runtime environments, and worker
registrations. Image cache keys include sources/generated build recipes,
package version, build timestamp, and component versions.
An interrupted Docker build transport is retried once using cached layers;
recipe/compiler failures are surfaced without retry. Cancelling startup also
cancels active image transfers and prevents another retry.
The Portal image builds its browser-safe shared schema dependency in both its
development and production stages; it does not rely on a maintainer's local
`packages/shared/dist`.

## Startup, storage, and shutdown

First interactive startup offers the four agent/runtime choices and permits
deferring setup. `--non-interactive` starts with saved settings, or no agents on
a fresh configuration. Backend startup does not require a coding-agent image or
provider key; AI work still requires its corresponding credentials.

The small Dockerode service/job manifest starts MongoDB, Redis, Azurite, Lowkey
Vault, migrations/storage initialization, API, Judge, scheduler, post-processing,
report generation, and Portal. Services have memory limits and owned-container
cleanup. Coding-worker and model-scanner images are built only for selected
Docker targets. Host targets use the bundled runners and installed CLIs.

| State | Default location |
| --- | --- |
| Agent choices and retained API/Portal ports | `$XDG_CONFIG_HOME/scope-server` or `~/.config/scope-server` |
| Service data and worker workspaces | `$XDG_DATA_HOME/scope-server` or `~/.local/share/scope-server` |
| Cache directory | `$XDG_CACHE_HOME/scope-server` or `~/.cache/scope-server` |
| Per-user process lock and current control address | `~/.local/state/scope-server` |

`--data-dir PATH` overrides service data without changing the per-user lock.
Only one local server runs per OS user, including across different data/config
directories. Persistent data uses host bind mounts rather than anonymous
container volumes. `--api-port` and `--portal-port` can select ports; otherwise
the first startup allocates ports and retains them for later starts.

Ctrl+C or `scope-server stop` stops owned services without deleting data.
Signal handlers remain active until cleanup finishes, including when npx
forwards another terminal signal. An unresponsive initial engine probe fails
after 15 seconds and can be cancelled rather than hanging startup.
Other Docker API requests have a two-minute socket inactivity timeout;
streaming image builds continue while the engine sends progress.
Container shutdown allows a 20-second graceful stop and aborts an unresponsive
stop request after 30 seconds. If that stop fails, the launcher reports the
failure and force-removes only the container whose ownership it already
verified. This also applies when replacing or disabling an owned service.
It does not remove host-backed data; failure of forced removal is still an error.
`scope-server status` reports the current instance; `scope-server restart`
stops and starts that instance. The launcher prints actual Portal/API URLs and
explicit `scope env add`/`scope env use` instructions. It never changes CLI
connection settings. See [CLI distribution](cli-distribution.md#named-connections).

## First local benchmark

Choose an installed host agent at first launch, or enable it later under
**Agents > Set up local agents**. Host consent is separate for each target.
For Docker targets, register the corresponding agent credential in Secrets
before enabling the target's model scanner and worker.

Create a project in Portal and add a criterion named `hello_scope_output` for
a `hello.js` program that prints exactly `Hello Scope!` and a newline. Portal
AI authoring is optional; when using it, register a provider key in Secrets and
save the **Portal AI** selection. The Judge and report generator still require
their own supported Copilot credential in Secrets, even when the coding agent
uses Claude's host login. Host login is not copied into Token Manager.

Use the separately packaged CLI (`npx --package ./scope-cli-0.0.0-dev.tgz scope`
in place of `scope` below), the printed API URL and the project's real ID:

```sh
scope env add local --url <printed-api-url>
scope env use local
scope --env local env set project <project-id>
scope --env local agent model list --id coder-acp-claude-code-host
scope --env local run submit --worker coder-acp-claude-code-host \
  --model haiku --criteria hello_scope_output --max-iterations 1 \
  --message 'Create hello.js that prints exactly Hello Scope! followed by a newline, with no other output. Run node hello.js to verify it.' \
  --no-stream
scope --env local run logs --id <request-id> --from-start
scope --env local run get --id <request-id> --output json
scope --env local run download --id <request-id> --dir ./result
node ./result/<request-id>/iteration-1/hello.js
```

The example uses the installed Claude CLI's advertised `haiku` alias; choose
an advertised model for the selected worker rather than assuming the same model
IDs apply to every runtime. Copilot's host worker is `coder-acp-copilot-host`.
Keep the **Request submitted** ID, not the separate submission ID.

For automatic reports, create an enabled project report template under
**Reports > Templates** before submitting, using a model supported by the
report generator's credential. Inspect it with
`scope --env local report list --run <request-id>` and
`scope --env local report get --id <report-id> --output markdown`, or open the
same report from the Portal run. Without optional HAR capture, reports may lack
raw tool transcripts; execution of the downloaded artifact is an independent
check, not something to infer solely from a report's verdict.

## Local agent setup

The launcher owns local processes and containers. The existing API and Portal
provide setup controls without directly spawning host processes. Launcher assets
belong to `apps/server/assets/`; `deploy/` remains the Kubernetes deployment.

When the launcher supplies `SCOPE_SERVER_CONTROL_URL` to the API:

| API endpoint | Behavior |
| --- | --- |
| `GET /api/v1/server` | Returns whether local setup is enabled and each target's runtime, enabled/available state, executable/version when known, and setup error if any. |
| `PUT /api/v1/server/agents/:workerType` | Forwards `{ enabled, executable?, consent? }` to the launcher for a known worker type. |

The API proxies launcher `GET /status` and `PUT /agents/:workerType`, validating
their response shape. Status reads have bounded transient retries. Setup
mutations are not automatically replayed: they can initiate a build.
Unchanged setup requests do not restart a ready target. Startup explicitly
clears availability for unselected targets, including previously registered
Docker agents, without starting or building them.
If setup fails after starting a runtime, including while publishing its
availability, the launcher attempts to stop it before reporting failure.
Cleanup failures are reported alongside the original setup error.
Docker setup can outlive a CLI `--wait` timeout. Inspect `scope agent status`
before retrying; a client timeout does not cancel the existing build. Coding
images include full language toolchains and need several gigabytes plus build
cache and temporary-layer headroom. Host-only setup avoids those image builds.

Without this setting, status reports `enabled: false` and mutations return 404.
The Portal's Agents page only shows **Set up local agents** when local setup is
enabled. The dialog supports host executable selection, explicit per-target
host consent, Docker setup, stopping targets, and progress/error display.
Host execution uses the user's machine and is not sandboxed by a workspace.

## Worker identities

| Runtime | Worker type | Queue |
| --- | --- | --- |
| Copilot Docker | `coder-acp-copilot` | `queue-coder-acp-copilot` |
| Copilot host | `coder-acp-copilot-host` | `queue-coder-acp-copilot-host` |
| Claude Docker | `coder-acp-claude-code` | `queue-coder-acp-claude-code` |
| Claude host | `coder-acp-claude-code-host` | `queue-coder-acp-claude-code-host` |

Host workers reuse the existing ACP and benchmark pipeline. They are ordinary
worker types to the scheduler: its claims, priorities, queue-depth policy, and
`{ requestId, runId }` envelope do not change. Adding a supported worker ID to
schemas does not enable a host runtime. Host submission requires an agent
explicitly marked available; the launcher is responsible for actual setup and
registration.

Host `--discover` initializes ACP and creates a session without sending a prompt
or authentication RPC. Native advertised model IDs and defaults are registered
through the existing agent/model APIs before the queue worker becomes available.
Docker targets run their existing provider scanner in dry-run mode and sync only
the selected target, without overwriting a host account's model catalog.

The host supervisor uses the existing queue-created/Mongo-connected startup
markers, manages coding-process descendants, and restarts cancelled workers.
Host cancellation skips the container-dev sentinel; Docker cancellation remains
unchanged. See the [Copilot host](../../apps/workers/coder-acp-copilot-host/README.md)
and [Claude host](../../apps/workers/coder-acp-claude-code-host/README.md) launch
contracts for environment variables and installed-login behavior.

## Boundaries

The local deployment is loopback-only and uses existing local/development
authentication behavior. There is no new local access token, browser session,
data-set identity protocol, backup/upgrade subsystem, or native authentication
research harness. Existing deployment authentication is unchanged.

Additional AI providers are for Portal AI through the existing Secrets/Token
Manager integration. Judge, feedback, and report generation retain their existing
provider behavior and credentials.

## Observed local coverage

The private artifacts were exercised outside the checkout on macOS arm64 with
Node.js 24.18 and a local Podman Docker-compatible Unix socket. The packaged
platform retained its project, criterion, provider settings, completed request
and report across a package restart. Both API and Portal displayed the same
valid build timestamp. No live Linux or native Windows acceptance is claimed.

| Path | Observed result |
| --- | --- |
| Claude Code host, installed 2.1.193 | Real coding, passing Judge evaluation, downloaded artifact producing exactly `Hello Scope!` plus a newline, and completed normal report. Setup worked through Portal and CLI. |
| Copilot Docker, 1.0.65 | Real coding and exact downloaded-artifact output. The Judge rejected missing captured execution history, and the completed report retained that failed verdict; it was not counted as a passing evaluation. |
| Copilot host | ACP initialization worked, but session creation was blocked by the installed CLI's personal MCP startup. No corrected host benchmark completed. |
| Claude Code Docker | Image-layer commit failed with `no space left on device` on the shared engine. No benchmark was submitted; the target was disabled through the CLI. |
| Portal AI | Real authoring passed with OpenAI, Anthropic's default `claude-sonnet-5`, OpenRouter and Foundry's configured `gpt-5.4-mini`. Compatible mode was exercised against an OpenAI endpoint, not every compatible server. |
| CLI connections | Named environments reached the running instance, and an explicit API URL overrode an intentionally unreachable named-environment URL. |

The validation engine reached 98% disk usage with 3.9 GB available. A stalled
control connection was recovered by refreshing only the validation-owned
connection; the shared engine was not restarted or globally pruned. These are
environment limitations, not successful acceptance of the two blocked agent
paths. Repair the installed CLI's own ACP/MCP setup or provide engine storage
before repeating the affected path. Scope does not silently change personal
CLI configuration or delete unrelated engine resources.
