# Scope CLI

Command-line interface for the Scope AI coding agent benchmarking platform.

## Installation

### Private npm artifact (no checkout required)

Obtain an authorized `scope-cli-<version>.tgz` artifact, then use the existing
`scope` executable:

```bash
npx --package /path/to/scope-cli-0.0.0-dev.tgz scope --help
# Or install the authorized artifact:
npm install --global /path/to/scope-cli-0.0.0-dev.tgz
```

The artifact is named **`@scope/cli`**, contains the same bundled CLI, and has no
runtime npm dependencies. The monorepo workspace remains **`cli`**. Publication
is intentionally disabled (`private: true`); this does not claim the proposed
package name is available in a public registry. Do not use the unrelated npm
package `scope`.

Maintainers build an artifact with `pnpm --filter cli pack:standalone` after
building the `shared` workspace. The build typechecks before bundling; outputs
are `dist/scope.mjs` and `dist/scope-cli-<version>.tgz`.
The bundle uses the canonical shared gate/type/retry exports without importing the
server-side shared barrel (and its runtime database/Redis dependencies).
Validate installation without contacting a registry using:

```bash
pnpm exec vitest run --config vitest.integration.config.ts \
  apps/cli/src/package.integration.test.ts
```

### Existing release installer

```bash
curl --fail --location https://raw.githubusercontent.com/microsoft/scope/main/install-cli.sh | bash
```

**Prerequisites:**
- Node.js >= 20
- `curl` (no GitHub authentication required for installation)

The installer downloads the latest published `cli/v*` release from `microsoft/scope`
and places `scope` in `~/.local/bin/` (override with `SCOPE_INSTALL_DIR`). It fails
clearly if no CLI release has been published yet. Add it to your PATH if needed:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## Configuration

### Named environments

```bash
scope env add local --url http://127.0.0.1:43127
scope env add staging --url https://your-scope-api.example.com --token <token>
scope env add local --url http://127.0.0.1:43127 --force
scope env list
scope env show staging
scope env use local
scope project list
scope project use <project-id>
scope --env staging run list --project <project-id>
scope --env staging env set url https://new-api.example.com
scope --env staging env set project <project-id>
printf '%s' "$MY_SCOPE_TOKEN" | scope --env staging env set token
scope --env staging env unset token
scope env use --clear
scope env remove staging
```

`local` is an ordinary, explicitly configured name. The server never adds or
selects it for you; there is no `--local`, server discovery, or dataset identity
mechanism. `env add` refuses an existing name so a saved token or project is not
silently discarded; pass `--force` to replace the whole entry, or use `env set`
to edit individual values. `env set` and `unset` accept `url`, `token`,
`project`, or `SCOPE_API_URL`, `SCOPE_TOKEN`, `SCOPE_PROJECT`. A URL is required
and cannot be unset; remove the environment instead. Omit a `set` value to read
it from piped stdin (useful for avoiding tokens in shell history).
`list`/`show` redact tokens.

Each named environment has an independent `environments/<name>.env` file plus
an `active-environment` selector under:

- macOS/Linux: `$XDG_CONFIG_HOME/scope`, or `~/.config/scope`.
- Windows: `%LOCALAPPDATA%/scope`, or `~/AppData/Local/scope`.

Files are plaintext and written with owner-only permissions where supported.
Protect them like credentials. Names are lowercase letters/digits, hyphens and
underscores, 1–64 characters, beginning with a letter or digit.

Connection precedence:

1. An **explicit command-owned API URL** (`--url`/`-u`, or MCP
   create/update's `--api-url`/`-u`) uses legacy URL, token and project resolution,
   even when a named environment is selected or the URL equals `SCOPE_API_URL`.
2. Root **`--env <name>`**, placed before the command.
3. The saved selection from **`env use`**.
4. Legacy configuration, if neither selector exists.

Named connections do not inherit ambient `SCOPE_API_URL`, `SCOPE_TOKEN`,
`SCOPE_PROJECT`, legacy project selection or legacy re-auth providers. An
explicit `--project` still overrides the named project's preference. `project use`
saves to that environment. Each operation retains its named URL/token/project
across REST calls, SSE/reconnects, retries, polling and artifact downloads.

MCP's resource `--url` and process `--env KEY=VALUE...` remain independent:

```bash
scope --env local mcp server create --id example --name Example --type stdio \
  --command node --env FOO=bar --project <project-id>
scope --env local mcp server create --id remote --name Remote --type http \
  --url https://mcp.example.com --project <project-id>
```

### Legacy configuration

There is no default API URL in either the installed CLI or source-mode
development. Set the URL of your Scope instance explicitly:

```bash
export SCOPE_API_URL=https://your-scope-api.example.com
```

Or pass it per-command with `-u`:

```bash
scope run list -u https://your-scope-api.example.com
```

API operations fail with configuration guidance when no URL is supplied.
`--help`, `--version`, and `scope update` do not need a Scope API URL.
`SCOPE_DEFAULT_API_URL` and `SCOPE_API_PORT` no longer select an API destination.
For local development, set `SCOPE_API_URL=http://localhost:<your-api-port>`
explicitly (in your environment or `.env`).

### Authentication

Set `SCOPE_TOKEN` to an IdP access token obtained for your API's audience. The CLI
sends that bearer unchanged; this release does not add interactive `scope auth`
commands, a Scope JWT, or token exchange. Already-enrolled callers remain compatible.

Before a **new identity** makes ordinary authenticated calls, explicitly enroll it:

```bash
curl --fail-with-body -sS \
  -X POST \
  -H "Authorization: Bearer $SCOPE_TOKEN" \
  -H "Cache-Control: no-store" \
  "${SCOPE_API_URL%/}/api/v1/users/me"
```

This POST has side effects (user/profile/`lastLoginAt`/eligible bootstrap updates):
never prefetch or poll it. `GET /api/v1/users/me` is read-only and returns
`403 user_not_enrolled` for missing enrollment or `403 user_disabled` for disabled
access; do not auto-enroll/retry these as token-refresh errors.

The API verifies every non-public bearer before active-user resolution. Redis hits
avoid Mongo; misses/outages read the exact identity without creating users. Cache
expiry is fixed/non-sliding (300 seconds by default), so database-only role/disable
changes can remain stale until expiry. Existing public/anonymous rollout is unchanged.
Never print or persist tokens in logs. See [the auth contract](../../docs/architecture/auth-rbac.md).

## Usage

```bash
# List all benchmark runs
scope run list

# Submit a run
scope run submit -s config/scenarios/hello-world.yaml -w coder-acp-copilot

# Get run details
scope run get -i <run-id>

# Stream logs
scope run logs -i <run-id>

# List criteria
scope criteria list

# Get help
scope --help
scope run --help
```

### Local agent setup

On a packaged Scope server with local setup enabled, the existing agent group
also discovers and configures the same targets shown by Portal Agents:

```bash
scope --env local agent status
scope --env local agent status -o json
scope --env local agent setup coder-acp-copilot-host --enable \
  --executable /path/to/copilot --consent --wait
scope --env local agent setup coder-acp-claude-code-host --enable --consent
scope --env local agent setup coder-acp-copilot --enable
scope --env local agent setup coder-acp-claude-code --disable
```

`agent status` reports availability, enabled state, executable, version and
errors through `GET /api/v1/server`. `agent setup` sends the selected target and
explicit settings to `PUT /api/v1/server/agents/:workerType`. Pass exactly one
of `--enable` or `--disable`; executable overrides and `--consent` apply only to
enabling a host target. Consent permits that host target to use its installed
CLI/login and execute on your machine. The server enforces first-use consent;
the CLI does not introduce authentication or infer consent.

These commands use normal named-environment/explicit-URL precedence and need
no project selection. Status reads retry transient failures. Setup mutations
are not automatically retried because they may start a build or host process;
inspect `agent status` after an interrupted setup before trying again.
Setup normally returns the accepted/current state promptly. Add `--wait` to
poll GET until the target becomes available, is disabled, or reports an error.
`--timeout <seconds>` bounds that wait (default 300); a timeout does not cancel
the server's setup. Polls retain the same selected connection and never replay
the setup PUT. Full stack stop/restart remains a `scope-server` operation, not
an agent setup action.
Existing `agent list/get/update` and model-management commands remain unchanged.

### Provider secrets and Portal AI selection

Manage credentials through the existing Secrets/Token Manager API, not your
named environment's Scope authentication token:

```bash
printf '%s' "$OPENAI_API_KEY" | scope --env local secret create \
  --type openai-api-key --api-key-stdin --comment 'Portal authoring'
printf '%s' "$OPENROUTER_API_KEY" | scope --env local secret create \
  --type openrouter-api-key --api-key-stdin
printf '%s' "$COMPATIBLE_KEY" | scope --env local secret create \
  --type openai-compatible --api-key-stdin \
  --endpoint https://inference.example.com/v1 --model my-model
printf '%s' "$ANTHROPIC_API_KEY" | scope --env local secret create \
  --type anthropic-api-key --value-stdin
scope --env local secret list --capability openai-api
scope --env local secret get <key-id>
scope --env local secret validate <key-id>
scope --env local secret update <key-id> --disable
scope --env local secret delete <key-id>
scope --env local secret portal-ai show
scope --env local secret portal-ai set openai --key-id <valid-key-id> --model gpt-4.1
scope --env local secret portal-ai set auto
```

`secret preview` accepts the same credential inputs as `create` and validates
without storing. Provider validation can issue a small request to the provider.
Creation returns metadata immediately; use `secret get` to inspect asynchronous
validation before pinning a key. Secret values are immutable: `update` edits
enabled state, comment, or expiration only. CLI output never fetches secret
values; credential request/response bodies are fully redacted in API logs.

OpenAI defaults to endpoint `https://api.openai.com/v1`, model `gpt-4.1`;
OpenRouter defaults to `https://openrouter.ai/api/v1`, model `openai/gpt-4.1`.
Use `--endpoint`/`--model` to override. Compatible credentials require both
and support bearer-authenticated `/chat/completions`, with HTTPS required
except HTTP localhost. The three new types store JSON `{endpoint,apiKey,model}`;
Anthropic retains its raw key format, and Foundry supports
`--type azure-ai-foundry --endpoint <url> --api-key-stdin [--model <model>]`.
`--value`/`--value-stdin` accept the complete raw or JSON credential instead.

`secret portal-ai set <provider>` replaces the nonsecret, instance-wide Portal
authoring selection via `/api/v1/keys/portal-ai`. Supported providers are `auto`,
`azure-ai-foundry`, `github-models`, `anthropic`, `openai`, `openrouter`, and
`openai-compatible`. Omit `--key-id` for provider round-robin; `auto` restores
legacy Foundry → GitHub selection and accepts no key/model overrides. This
does not change Judge, feedback, report, or coding-worker provider selection.

## Updating

For a private npm installation, obtain the next authorized tarball and reinstall
it or pass its path to `npx`. The following self-update commands and notifications
apply to the existing GitHub release installation:

Update to the latest version:

```bash
scope update
```

This command requires `gh` installed and authenticated (`gh auth login`) and
downloads from the same public `microsoft/scope` repository.
Alternatively, re-run the install script without `gh`:

```bash
curl --fail --location https://raw.githubusercontent.com/microsoft/scope/main/install-cli.sh | bash
```

The CLI will also notify you when a newer version is available. Suppress this with:

```bash
export SCOPE_NO_UPDATE_CHECK=1
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SCOPE_API_URL` | API base URL; required for API operations unless `-u` is provided. No default |
| `SCOPE_TOKEN` | Caller-provided IdP access token for authenticated API calls; new identities must explicitly enroll |
| `SCOPE_NO_UPDATE_CHECK` | Set to `1` to suppress update notifications |
| `GH_TOKEN` / `GITHUB_TOKEN` | GitHub token for authenticated API calls (update checks, install script) |
