---
title: Configure the CLI
description: Point the Scope CLI at one or more deployments with named environments, or with environment variables.
---

The `scope` CLI needs to know which Scope API to call, which bearer
token to send (if your deployment requires one), and which project to
operate on. There is no default API URL. You can configure the
connection in two ways:

- **Named environments** (`scope env`): save one or more connections
  and switch between them. Recommended when you work with more than one
  deployment, for example a local stack and a shared one.
- **Legacy configuration**: environment variables and command flags.
  Convenient for CI and one-off scripts.

## Named environments

A named environment stores an API URL, an optional Scope bearer token,
and an optional project:

```bash
scope env add local --url http://127.0.0.1:43127
scope env add staging --url https://your-scope-api.example.com --token <token>
scope env use local
scope project list
```

`env add` refuses a name that already exists, so a saved token or
project is never discarded by accident. Pass `--force` to replace the
whole entry, or use `env set` to change one value.

Names use lowercase letters, digits, hyphens, and underscores, are 1–64
characters long, and begin with a letter or digit. `local` is an
ordinary name: Scope does not create or select it for you.

### Select an environment

```bash
scope env use staging                  # select for all later commands
scope --env local run list             # use another environment for one command
scope env use --clear                  # go back to legacy configuration
```

Place the root `--env <name>` option before the command name. This
matters for commands such as `scope mcp server create`, which has its
own `--env KEY=VALUE` option for MCP process variables:

```bash
scope --env local mcp server create --id example --name Example \
  --type stdio --command node --env FOO=bar --project <project-id>
```

### Inspect environments

```bash
scope env list
scope env show            # the selected environment
scope env show staging
```

`list` and `show` print `[REDACTED]` instead of the token. Add
`-o json` or `-o yaml` for machine-readable output.

### Edit values

`env set` and `env unset` act on the environment chosen by `--env`, or
the selected one. Keys are `url`, `token`, and `project`, or their
`SCOPE_API_URL`, `SCOPE_TOKEN`, and `SCOPE_PROJECT` names:

```bash
scope --env staging env set url https://new-api.example.com
scope --env staging env set project <project-id>
printf '%s' "$MY_SCOPE_TOKEN" | scope --env staging env set token
scope --env staging env unset token
```

Omit the value to read it from piped stdin, which keeps tokens out of
shell history. The URL is required and cannot be unset; remove the
environment instead:

```bash
scope env remove staging
```

Removing the selected environment also clears the selection.

### Projects

`scope project use <project-id>` saves the project to the environment
in use, so each deployment remembers its own project. An explicit
`--project <id>` on a command still overrides it.

### What a named environment ignores

A named environment is self-contained. It does not read the
`SCOPE_API_URL`, `SCOPE_TOKEN`, or `SCOPE_PROJECT` environment
variables, or the legacy selected project. The same URL, token, and
project are used for every call a command makes, including log streams,
reconnects, retries, polling, and artifact downloads.

## Legacy configuration

When no environment is selected and `--env` is not passed, the CLI
reads:

| Variable | Purpose |
| --- | --- |
| `SCOPE_API_URL` | Scope API base URL |
| `SCOPE_TOKEN` | Bearer token sent with each request |
| `SCOPE_PROJECT` | Project for project-scoped commands |

These can come from your shell or from the nearest `.env` file in the
current directory or one of its parents. In this mode, `scope project use <id>`
saves the selected project to `config.json` in the CLI configuration
directory.

## Precedence

For each command, the CLI picks its connection in this order:

1. An explicit URL on the command (`-u`/`--url`, or `--api-url` on
   `scope mcp server create` and `update`). This uses legacy token and
   project resolution, even when an environment is selected.
2. The root `--env <name>` option.
3. The environment saved with `scope env use`.
4. Legacy configuration.

For the project, `--project <id>` always wins. Otherwise a named
environment uses its saved project. In legacy mode the CLI uses
`SCOPE_PROJECT`, then the project saved with `scope project use`.

## Where configuration is stored

| Platform | Directory |
| --- | --- |
| macOS and Linux | `$XDG_CONFIG_HOME/scope` when `XDG_CONFIG_HOME` is an absolute path, otherwise `~/.config/scope` |
| Windows | `%LOCALAPPDATA%\scope` |

The directory contains:

- `environments/<name>.env`: one dotenv file per named environment.
- `active-environment`: the name selected with `scope env use`.
- `config.json`: the legacy-mode selected project.
- `update-check.json`: when the CLI last checked for a new release.

Environment files hold tokens in plain text and are written with
owner-only permissions where the platform supports them. Protect them
like any other credential. An existing `~/.config/scope/config.json` is
still read until the next `scope project use` writes the new location.

## Related

- [Install the CLI](/getting-started/install-cli/)
- [Submitting requests (CLI)](/guides/submitting-requests-cli/)
