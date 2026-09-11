# Scope Server

Scope Server adds a local npx deployment alongside the existing Compose and
Kubernetes deployments. Implementation is in progress; this document does not
announce a published npm release.

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
`scope-server status` reports the current instance; `scope-server restart`
stops and starts that instance. The launcher prints actual Portal/API URLs and
explicit `scope env add`/`scope env use` instructions. It never changes CLI
connection settings. See [CLI distribution](cli-distribution.md#named-connections).

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
