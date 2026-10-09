# Installed Claude Code host worker

`coder-acp-claude-code-host` consumes
**`queue-coder-acp-claude-code-host`**. It runs the existing packaged
`@agentclientprotocol/claude-agent-acp` adapter with
`CLAUDE_CODE_EXECUTABLE` pointing at the user's installed Claude Code.
There is no custom ACP bridge. The adapter is pinned to `0.52.0`, matching the
existing Docker worker's `versions.env`; the user's CLI is never installed or
upgraded by Scope.

The app reuses `coder-acp-claude-code/worker` and the complete existing
queue/ACP/logging/snapshot/cancellation/Judge/post-processing pipeline. Docker
startup, token acquisition and queue defaults remain unchanged.

## Launch contract

Requires Node.js 22+, an installed Claude Code CLI supporting stream-json
input/output, permission modes, and `--strict-mcp-config`, plus an existing
login. The launcher must obtain explicit consent **for this host target**:
agent tasks run with the user's account and access, not in a sandbox.

```sh
pnpm --filter coder-acp-claude-code-host... build
node apps/workers/coder-acp-claude-code-host/dist/index.js --detect

# After passing the host-reachable Scope service environment:
SCOPE_HOST_WORKSPACE_ROOT="$PWD/.scope/workspaces/claude" \
SCOPE_HOST_EXECUTABLE="/absolute/path/to/claude" \
node apps/workers/coder-acp-claude-code-host/dist/index.js
```

`--detect` only invokes bounded `--version` / `--help` checks and resolves the
packaged adapter; it does not create sessions or call providers. JSON fields are
`workerType`, `executable`, `version`, `adapter`, `agentVersion` and
`componentVersions`. Register the emitted
`claude-code-${cliVersion}-acp-${adapterVersion}` under the **Claude host** agent
type and ordinary queue. Worker build identity adds `BUILD_TIME` and `GIT_COMMIT`
in the same way as other workers.

Use **`--discover`** for registration after host consent:

```sh
SCOPE_HOST_WORKSPACE_ROOT="$PWD/.scope/workspaces/claude" \
node apps/workers/coder-acp-claude-code-host/dist/index.js --discover
```

This initializes the existing adapter and creates a native ACP session against
the installed CLI without sending a prompt, invoking authentication RPCs, or
changing permission modes. It returns the detection fields plus
`supportedModels`, `models: { id, name }[]` and optional native `defaultModel`.
Metadata must be advertised by the actual session; unavailable models/login
cause setup to fail rather than inventing a catalog. The generic no-prompt
transport is reused from `coder-acp-copilot/acp-client`; Claude execution still
uses its own existing worker/adapter. Discovery uses a separate child workspace,
removed afterward, and a bounded 30-second ACP handshake.

Executable lookup is `SCOPE_HOST_EXECUTABLE`, then `CLAUDE_CODE_EXECUTABLE`, then
`claude` on `PATH`. The workspace root must be an absolute, dedicated directory.
Runs get separate child directories, and teardown removes only the completed
run. Host queue selection ignores inherited Docker worker/queue names.

Service connectivity, supervisor/cancellation responsibilities and optional HAR
configuration are the same as the
[Copilot host launch contract](../coder-acp-copilot-host/README.md#launch-contract):
MongoDB, queue/blob storage, Redis, Scope API, Judge and existing Token Manager
helpers need host-reachable endpoints. Judge downloads blob snapshots and does
not need a host-workspace mount.

## Existing login and config isolation

No Token Manager agent credential is acquired or injected. The adapter inherits
the user's `HOME` and credential environment; only the installed executable and
session auto-updater setting are supplied. `ANTHROPIC_MODEL` is set when a run
explicitly requests a model. The worker does not read a repository `.env` or
install a replacement authentication policy.

Host runs always isolate personal Claude Code settings and MCP configuration
for benchmark reproducibility while keeping `HOME`/`CLAUDE_CONFIG_DIR` in place
for login reuse. The ACP session metadata sets
`claudeCode.options.settingSources` to `[]` and passes
`--strict-mcp-config` through the adapter's `extraArgs`, so user, project,
local, and project `.mcp.json` sources are ignored. Docker startup and token
acquisition remain unchanged.

Inherited HTTP(S)/ALL proxy variables and trust settings are preserved. If an
inherited proxy exists, Scope does not replace it with a HAR proxy. Otherwise,
explicit Scope proxy configuration uses the existing capture path; the gateway
token-replacement plugin is disabled. Evaluation/feedback/report provider
configuration remains independent of this host-agent login.
