---
title: Install the CLI
description: Install the Scope CLI to submit requests and manage benchmarks from the terminal.
---

The `scope` CLI lets you submit requests, list runs, stream logs,
and manage profiles — all from your terminal.

## Prerequisites

- **Node.js ≥ 20** — [nodejs.org](https://nodejs.org)
- **GitHub CLI (`gh`)** — authenticated with access to the
  `growth-ecosystems/scope-doc` repo.  
  Alternatively, set a `GH_TOKEN` or `GITHUB_TOKEN` environment
  variable with `repo` scope.

## One-liner install

```bash
gh api repos/growth-ecosystems/scope-doc/contents/install-cli.sh \
  -H "Accept: application/vnd.github.raw" | bash
```

This downloads and installs the latest release to
`~/.local/bin/scope`. Override the location with the
`SCOPE_INSTALL_DIR` environment variable:

```bash
gh api repos/growth-ecosystems/scope-doc/contents/install-cli.sh \
  -H "Accept: application/vnd.github.raw" | SCOPE_INSTALL_DIR=~/bin bash
```

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
replacing the current binary in place.

## What's next

- [Submitting requests (CLI)](/guides/submitting-requests-cli/) —
  the full CLI workflow guide.
- [Submitting requests (REST API)](/guides/submitting-requests-api/)
  — the endpoints the CLI wraps.
