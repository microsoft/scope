---
title: Install the CLI
description: Install the Scope CLI to submit requests and manage benchmarks from the terminal.
---

The `scope` CLI lets you submit requests, list runs, stream logs,
and manage profiles — all from your terminal.

## Prerequisites

- **Node.js ≥ 20** — [nodejs.org](https://nodejs.org)
- **curl** — no GitHub authentication or private repository access is
  required to install the public CLI.

Using the CLI with a Scope deployment is separate from installing it:
your deployment administrator provides the API URL and any required
credentials. See [Access](/getting-started/access/).

## One-liner install

```bash
curl --fail --location https://raw.githubusercontent.com/microsoft/scope/main/install-cli.sh | bash
```

This downloads and installs the latest published, non-prerelease `cli/v*`
release from `microsoft/scope` to
`~/.local/bin/scope`. Override the location with the
`SCOPE_INSTALL_DIR` environment variable:

```bash
curl --fail --location https://raw.githubusercontent.com/microsoft/scope/main/install-cli.sh | SCOPE_INSTALL_DIR=~/bin bash
```

The installer checks the downloaded bundle's version before replacing an
existing installation. Missing releases, download errors, and version
mismatches fail without replacing your installed CLI. If no public CLI
release has been published yet, the installer reports that explicitly;
follow [Local development](/getting-started/local-development/) to build
the CLI from source instead.

## Add to PATH

If `~/.local/bin` is not already on your `PATH`, add it to your
shell profile:

```bash
# ~/.bashrc, ~/.zshrc, or ~/.profile
export PATH="$HOME/.local/bin:$PATH"
```

Then reload your shell or run `source ~/.bashrc` (or equivalent).

## Verify the installation

```bash
scope --version
```

You should see the installed version number printed to stdout.

## Updating

```bash
scope update
```

This downloads and installs the latest `cli/v*` release,
replacing the current binary in place. This update command requires the
GitHub CLI (`gh`) installed and authenticated (`gh auth login`), but no
private repository access. Alternatively, rerun the public installer
above without GitHub authentication.

## What's next

- [Submitting requests (CLI)](/guides/submitting-requests-cli/) —
  the full CLI workflow guide.
- [Submitting requests (REST API)](/guides/submitting-requests-api/)
  — the endpoints the CLI wraps.
