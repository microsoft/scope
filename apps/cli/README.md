# Scope CLI

Command-line interface for the Scope AI coding agent benchmarking platform.

## Installation

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

### Provider secrets

`scope secret` manages provider credentials (GitHub tokens, Anthropic keys,
Azure AI Foundry keys) through the Secrets/Token Manager API, matching the
Portal's secrets page:

```bash
printf '%s' "$ANTHROPIC_API_KEY" | scope secret create \
  --type anthropic-api-key --value-stdin --comment 'Claude Code worker'
printf '%s' "$FOUNDRY_KEY" | scope secret create --type azure-ai-foundry \
  --endpoint https://<resource>.services.ai.azure.com/models --api-key-stdin [--model <model>]
scope secret list [--capability <capability>]
scope secret get <key-id>
scope secret validate <key-id>
scope secret update <key-id> --disable
scope secret delete <key-id>
```

`secret preview` accepts the same credential inputs as `create` and validates
them with the provider without storing anything. Creation returns metadata
immediately; use `secret get` to inspect asynchronous validation. Secret values
are immutable: `update` edits only the enabled state, comment, or expiration.

The CLI never fetches or prints secret values in any output format, and
credential request/response bodies are fully redacted in API logs. Prefer
`--value-stdin`/`--api-key-stdin`; `--value`/`--api-key` print a warning
because they expose the secret in shell history and process listings. Writes
(`create`, `preview`) are never retried automatically; metadata reads retry
transient failures.

## Updating

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
