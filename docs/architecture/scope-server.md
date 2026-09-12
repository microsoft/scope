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

The package is private and is not published to any registry, so
`npm install -g @scope/server` does not work. Install it from the artifact path
instead, which also puts `scope-server` on `PATH`:

```sh
npm install -g --omit=optional ./scope-server-0.1.0.tgz
scope-server --help
```

Use `--omit=optional`. Without it the install is about 618 MB, because
`@anthropic-ai/claude-agent-sdk` pulls a 225 MB platform-specific `claude`
binary as an optional dependency. Host runs never execute that copy: the ACP
adapter's `claudeCliPath()` returns `CLAUDE_CODE_EXECUTABLE` when it is set, and
the host runner always sets it to the user's own installed CLI. Omitting
optional dependencies also skips `cpu-features`, which `ssh2` does not require.
The separately packaged CLI installs the same way and needs no such flag.

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
Scope Server also builds the Rust gateway proxy from source. Its first build
compiles hundreds of crates and can take materially longer than the Node.js
images while consuming several gigabytes of Docker engine storage. Startup
streams Docker build progress and turns gateway `ENOSPC` failures into an
actionable prompt to free or move Docker storage before retrying.
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

Startup reclaims containers left by an earlier launcher that exited without
cleaning up, matched on the ownership label so another user's services are never
touched. Those are reported as `reclaimed`, not `stopping`: a wall of "stopping"
lines directly after a `start` command reads like the platform is shutting down.
A clean start reports nothing. This step deliberately does not reuse the full
`stop()` path, which would also remove the network startup has just created —
`startService` removes its own stale container anyway, so reclamation exists for
containers that are not part of the run about to begin, such as a coding worker
that was enabled previously but is not selected now.

Ctrl+C or `scope-server stop` stops owned services without deleting data.
Signal handlers remain active until cleanup finishes, including when npx
forwards another terminal signal. An unresponsive initial engine probe fails
after 15 seconds and can be cancelled rather than hanging startup.
Ordinary Docker API requests have a two-minute socket inactivity timeout.
Once an image build or pull starts streaming, that inactivity timeout is
disabled: committing or decompressing large layers can legitimately be silent
for several minutes. Ctrl+C still cancels the active image stream.
Container shutdown allows a 20-second graceful stop and aborts an unresponsive
stop request after 30 seconds. If that stop fails, the launcher reports the
failure and force-removes only the container whose ownership it already
verified. This also applies when replacing or disabling an owned service.
It does not remove host-backed data; failure of forced removal is still an error.
Shutdown follows reverse service order and can take several minutes when
services use their full grace period.
The launcher uses Commander with the same styled help conventions as the Scope
CLI. `scope-server start` is the default when no subcommand is supplied; the
other subcommands are `stop`, `restart`, and `status`. All commands accept the
launcher options `--data-dir`, `--api-port`, `--portal-port`, and
`--non-interactive` for parity with older option parsing. `scope-server status`
reports the current instance; `scope-server restart` stops and starts that
instance. The launcher prints actual Portal/API URLs and explicit
`scope env add`/`scope env use` instructions. It never changes CLI connection
settings. See [CLI distribution](cli-distribution.md#named-connections).

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
same report from the Portal run. If HAR capture fails, reports may lack raw
tool transcripts; execution of the downloaded artifact remains an independent
check, but missing capture is a setup failure rather than an expected
local-server mode.
Capture is enabled for the **Copilot Docker** worker only, matching the state of
the gateway migration: `docker-compose.yml` runs Copilot on the gateway but still
pins ACP Claude Code to its DevProxy sidecar. That pin is not arbitrary — routing
Claude Code through the gateway makes its natively compiled CLI fail with
`Unable to connect to API (ConnectionRefused)` and record an empty HAR. The local
stack ships no DevProxy sidecar, so Claude Docker runs uncaptured until the
gateway supports it (Phase 4). The worker env keeps the legacy
`DEV_PROXY_ENABLED` and `DEV_PROXY_API_URL` names because both gateway and
DevProxy clients still read them; only `PROXY_BACKEND` selects the backend.

**Host agents do not capture by default.** Opt in with `SCOPE_HOST_CAPTURE=1`,
and expect it to fail with current CLIs. The worker routes its subprocess
through the gateway using Node-only mechanisms — `NODE_OPTIONS=--use-env-proxy`,
`NODE_TLS_REJECT_UNAUTHORIZED` and `NODE_EXTRA_CA_CERTS` — but a host worker
ultimately spawns the user's own installed CLI, which is a natively compiled
binary. It honours none of those and does not trust the gateway's interception
CA. A real Claude Code host run with capture forced on fails with
`Unable to connect to API (FailedToOpenSocket)` and records an empty HAR, so
forcing it on would break the working host path to collect evidence it cannot
actually collect. Host runs therefore rely on snapshots, evaluation and
downloaded-artifact execution rather than a raw HTTP transcript.

In short, gateway capture is only known to work for Copilot. Extending it to
Claude Code — in either runtime — needs a CA-trust and proxy mechanism its
native CLI actually honours, and is the same work that blocks Phase 4.

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
Host-agent consent states that the agent runs as the user with their existing
CLI login, that its personal MCP servers and agent settings are disabled for
reproducibility, and that its traffic is decrypted by the local gateway CA when
host capture is opted into. The intercepted traffic runs under the user's own
installed CLI login; Scope does not weaken TLS validation globally or copy the
host login into Token Manager.

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

Host workers reuse installed CLI logins without relocating `HOME` or
`CLAUDE_CONFIG_DIR`, but they must not inherit personal agent configuration that
would make benchmark results machine-dependent. Copilot host starts the CLI with
`--disable-builtin-mcps` and one `--disable-mcp-server <name>` per server listed
in `~/.copilot/mcp-config.json` (read-only). Claude host sends ACP metadata with
`claudeCode.options.settingSources: []` and adapter `extraArgs:
["--strict-mcp-config"]`. Docker workers keep their existing clean-container
behavior.

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
valid build timestamp. A fresh artifact download after restart still produced
the exact expected output. That Ctrl+C shutdown took about four minutes, left
no owned containers, and released the runtime record without manual cleanup.
The later image-stream fix was also exercised through packaged startup, the
Claude Docker benchmark, and normal shutdown with no owned containers remaining.
Validation-only credential stores were removed after their containers stopped;
original vault entries and host logins were retained. No live Linux or native
Windows acceptance is claimed.

| Path | Observed result |
| --- | --- |
| Claude Code host, installed 2.1.193 | Real coding, passing Judge evaluation, downloaded artifact producing exactly `Hello Scope!` plus a newline, and completed normal report. Setup worked through Portal and CLI. |
| Copilot Docker | Real coding, gateway capture, and a passing evaluation. Request `0735ba0e` extracted 4 tool calls from the HAR, generated ATIF 1/1, and passed `hello_scope_output`, whose prompt requires evidence in the captured tool-call history. The downloaded artifact printed exactly `Hello Scope!` with exit 0 and its report completed. An earlier run of this same path failed the Judge for missing execution history because capture was disabled. |
| Copilot host | ACP initialization worked, but session creation was blocked by the installed CLI's personal MCP startup. No corrected host benchmark completed. |
| Claude Code Docker, ACP 0.52.0 / SDK 0.3.191 | Completed a real `claude-haiku-4-5-20251001` benchmark with a passing Judge evaluation, exact artifact output and a completed report, while running **uncaptured**. A later attempt with gateway capture enabled failed with `Unable to connect to API (ConnectionRefused)` and an empty HAR, which is why capture is scoped to the Copilot worker. |
| Portal AI | Real authoring passed with OpenAI, Anthropic's default `claude-sonnet-5`, OpenRouter and Foundry's configured `gpt-5.4-mini`. Compatible mode was exercised against an OpenAI endpoint, not every compatible server. |
| CLI connections | Named environments reached the running instance, and an explicit API URL overrode an intentionally unreachable named-environment URL. |

The first Claude Docker build exhausted the shared engine's disk. After the
operator freed storage, the retry exposed an image-stream timeout during silent
layer commits; the stream-specific fix above resolved it. The original failed
builds remain distinct from the subsequent successful benchmark. Stalled
management access was recovered through a validation-owned connection, without
restarting or globally pruning the shared engine.

Copilot host remains blocked by the installed CLI's own ACP/MCP setup. Scope
does not silently change personal CLI configuration or delete unrelated engine
resources.
