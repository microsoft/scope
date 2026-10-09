# Installed Copilot host worker

`coder-acp-copilot-host` consumes **`queue-coder-acp-copilot-host`** using the
installed Copilot CLI's native `--acp` mode. It reuses
`coder-acp-copilot/worker`: the existing queue processor, workspace seeding,
ACP logging, iteration snapshots, cancellation, Judge calls and post-processing.
The Docker worker keeps its existing defaults and separate queue.

## Launch contract

Requires Node.js 22+, an installed Copilot CLI supporting `--acp`, `--yolo`,
`--no-auto-update`, `--disable-builtin-mcps`, `--disable-mcp-server`, and
`--additional-mcp-config`, plus an existing CLI login. Scope does not install or
upgrade the host CLI. The launcher must obtain consent **for this host target**
before starting it: tasks run with the user's account and filesystem/network
access, not in a sandbox.

Build from the workspace root:

```sh
pnpm --filter coder-acp-copilot-host... build
node apps/workers/coder-acp-copilot-host/dist/index.js --detect
```

`--detect` only executes bounded `--version` / `--help` checks; it does not open
an ACP session, authenticate, prompt, or connect to Scope services. It emits one
JSON object with `workerType`, `executable`, `version`, `agentVersion` and
`componentVersions`. Register that exact `agentVersion` under the **host**
worker type, not the Docker type. The worker's build identity is
`${agentVersion}-${BUILD_TIME || "unknown"}-${GIT_COMMIT || "unknown"}`, matching
the existing queue processor.

For registration, use **`--discover`** after obtaining host consent:

```sh
SCOPE_HOST_WORKSPACE_ROOT="$PWD/.scope/workspaces/copilot" \
node apps/workers/coder-acp-copilot-host/dist/index.js --discover
```

It performs native ACP `initialize` and `session/new`, reads advertised model
metadata, and closes the subprocess without authentication RPCs, prompts, or
permission-mode changes. It adds `supportedModels: string[]`,
`models: { id: string, name: string }[]` and optional `defaultModel` to the
detection output. Models come only from the native session's model list or model
config options; absent metadata is an actionable setup error, not a synthesized
catalog. A default is included only when the native current model is advertised.
The discovery workspace is removed on success or failure. Allow up to 90 seconds
for the version/help checks plus the bounded 30-second ACP handshake.

Start with the existing service environment plus:

```sh
SCOPE_HOST_WORKSPACE_ROOT="$PWD/.scope/workspaces/copilot" \
SCOPE_HOST_EXECUTABLE="/absolute/path/to/copilot" \
node apps/workers/coder-acp-copilot-host/dist/index.js
```

`SCOPE_HOST_EXECUTABLE` is optional; discovery otherwise searches `PATH`.
`SCOPE_HOST_WORKSPACE_ROOT` is required, absolute, and dedicated to this worker.
Each run gets its own child directory; teardown removes only that run directory.
The host queue and identity are fixed, even if Docker `WORKER_NAME` or
`QUEUE_NAME` variables were inherited.

The launcher supplies host-reachable values for:

| Environment | Purpose |
| --- | --- |
| `MONGO_CONNECTION_STRING`, `MONGO_DATABASE` | Requests and run state |
| `STORAGE_CONNECTION_STRING` | Azure/Azurite queue **and blob** endpoints |
| `REDIS_HOST`, `REDIS_PORT`, optional `REDIS_PASSWORD` | Live logs and cancellation |
| `SCOPE_MT_API_URL` | Task/criteria/skills/codebase retrieval |
| `JUDGE_SERVICE_URL` | Existing evaluation service |
| `TOKEN_MANAGER_URL` | Existing feedback/evaluation helpers, **not host-agent login** |
| `QUEUE_NAME_POST_PROCESSOR` | Optional; defaults to `post-processor-queue` |
| `BUILD_TIME`, `GIT_COMMIT` | Optional build identity; match registered version |

Docker-only DNS names such as `mongodb` and `azurite` are not host endpoints.
Judge receives blob snapshots, so no shared host-workspace mount is required.
Judge/feedback/report credentials retain their existing independent requirements.

## Login, proxy and lifecycle

The host entry does not read a repository `.env` or replace `HOME`, auth files,
or inherited credentials. It skips Token Manager acquisition for Copilot and
does not invoke the ACP authentication RPC. Log in with the installed CLI
before enabling the target. Auto-update is disabled for the Scope session.

Host runs always isolate personal MCP configuration for benchmark
reproducibility while keeping `HOME` in place for login reuse. The worker reads
`~/.copilot/mcp-config.json` read-only, logs the configured server names, starts
the CLI with `--disable-builtin-mcps`, and adds one
`--disable-mcp-server <name>` flag per personal server. Missing, unreadable,
empty, or malformed MCP config files are logged and do not stop the run. If the
Scope MCP gateway is configured, it is still supplied through
`--additional-mcp-config`; the Docker worker's existing gateway behavior is
unchanged.

Existing `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and lowercase equivalents take
precedence: when any is set, Scope leaves the CLI's proxy and trust environment
intact and skips its own HAR proxy. Without an inherited proxy, explicitly
configured Scope proxy settings use the existing HAR integration. The gateway
token-replacement plugin is disabled for host workers. For the DevProxy backend,
`DEV_PROXY_HAR_DIR` must point to a host-visible output directory; for the gateway,
the existing client downloads the HAR. Supply a per-worker `TMPDIR` under the
server's writable data directory if runtime artifacts must remain there.

The existing cancel subscriber exits the worker. The launcher must supervise
and restart enabled host workers and terminate their process group on exit or
stop, so coding-agent descendants do not outlive a cancelled run. Optional MCP
gateway/Kubedock features retain their existing configuration requirements; the
host worker does not create container isolation or silently provision them.
