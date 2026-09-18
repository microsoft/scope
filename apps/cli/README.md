# Scope CLI

Command-line interface for the Scope AI coding agent benchmarking platform.

## Installation

```bash
gh api repos/growth-ecosystems/scope-doc/contents/install-cli.sh -H "Accept: application/vnd.github.raw" | bash
```

**Prerequisites:**
- Node.js >= 20
- `gh` CLI installed and authenticated (`gh auth login`)

The installer downloads the latest release and places `scope` in `~/.local/bin/`. Add it to your PATH if needed:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## Configuration

Set the API URL to your Scope instance:

```bash
export SCOPE_API_URL=https://your-scope-api.example.com
```

Or pass it per-command with `-u`:

```bash
scope run list -u https://your-scope-api.example.com
```

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

Or re-run the install script:

```bash
gh api repos/growth-ecosystems/scope-doc/contents/install-cli.sh -H "Accept: application/vnd.github.raw" | bash
```

The CLI will also notify you when a newer version is available. Suppress this with:

```bash
export SCOPE_NO_UPDATE_CHECK=1
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SCOPE_API_URL` | Default API base URL |
| `SCOPE_API_PORT` | Derive API URL as `http://localhost:$PORT` when `SCOPE_API_URL` is unset |
| `SCOPE_TOKEN` | Caller-provided IdP access token for authenticated API calls; new identities must explicitly enroll |
| `SCOPE_NO_UPDATE_CHECK` | Set to `1` to suppress update notifications |
| `GH_TOKEN` / `GITHUB_TOKEN` | GitHub token for authenticated API calls (update checks, install script) |
