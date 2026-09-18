# Scope CLI

Command-line interface for the Scope AI coding agent benchmarking platform.

## Installation

```bash
gh api repos/microsoft/scope/contents/website/install-cli.sh -H "Accept: application/vnd.github.raw" | bash
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
gh api repos/microsoft/scope/contents/website/install-cli.sh -H "Accept: application/vnd.github.raw" | bash
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
| `SCOPE_NO_UPDATE_CHECK` | Set to `1` to suppress update notifications |
| `GH_TOKEN` / `GITHUB_TOKEN` | GitHub token for authenticated API calls (update checks, install script) |
