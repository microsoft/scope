---
title: Install the CLI
description: Install the Scope CLI to submit requests and manage benchmarks from the terminal.
---

The `scope` CLI lets you submit requests, list runs, stream logs,
and manage profiles — all from your terminal.

## Prerequisites

- **Node.js ≥ 20** — [nodejs.org](https://nodejs.org)
- **GitHub CLI (`gh`)** — authenticated with access to the
  `microsoft/scope` repo.

## One-liner install

```bash
gh api repos/microsoft/scope/contents/website/install-cli.sh \
  -H "Accept: application/vnd.github.raw" | bash
```

This downloads and installs the latest `cli/v*` release from
`microsoft/scope` to
`~/.local/bin/scope`. Override the location with the
`SCOPE_INSTALL_DIR` environment variable:

```bash
gh api repos/microsoft/scope/contents/website/install-cli.sh \
  -H "Accept: application/vnd.github.raw" | SCOPE_INSTALL_DIR=~/bin bash
```

The installer requires a published `cli/v*` release with a `scope.mjs`
asset. If none is available, follow
[Local development](/getting-started/local-development/) to build the CLI
from source.

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
