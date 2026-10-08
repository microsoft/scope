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
